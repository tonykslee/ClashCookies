export const DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS = 101;
export const DEFAULT_ALL_BASES_OPEN_HOURS_LEFT = 0;
export const MAX_ALL_BASES_OPEN_HOURS_LEFT = 24;

export type WarPlanComplianceConfig = {
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
};

type MaybeConfig = {
  nonMirrorTripleMinClanStars?: number | null;
  allBasesOpenHoursLeft?: number | null;
};

type ParseResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

function toSafeNonNegativeInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(Number(value))) return null;
  const parsed = Math.trunc(Number(value));
  if (parsed < 0) return null;
  return parsed;
}

/** Purpose: parse optional integer input for non-mirror min-stars config; blank means unset/default. */
export function parseNonMirrorTripleMinClanStarsInput(raw: string | null | undefined): ParseResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      error:
        "`minimum clan stars before tripling non-mirror` must be a non-negative integer.",
    };
  }
  const parsed = Math.trunc(Number(text));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ok: false,
      error:
        "`minimum clan stars before tripling non-mirror` must be a non-negative integer.",
    };
  }
  return { ok: true, value: parsed };
}

/** Purpose: parse optional `H`/`Hh` input for all-bases-open cutoff; blank means unset/default. */
export function parseAllBasesOpenHoursLeftInput(raw: string | null | undefined): ParseResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };

  const match = text.match(/^(\d+)(h)?$/i);
  if (!match) {
    return {
      ok: false,
      error:
        "`all bases open for 3 star time-left` must be a non-negative integer hour value like `8` or `8h`.",
    };
  }

  const parsed = Math.trunc(Number(match[1]));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ok: false,
      error:
        "`all bases open for 3 star time-left` must be a non-negative integer hour value like `8` or `8h`.",
    };
  }
  if (parsed > MAX_ALL_BASES_OPEN_HOURS_LEFT) {
    return {
      ok: false,
      error: `\`all bases open for 3 star time-left\` must be between 0 and ${MAX_ALL_BASES_OPEN_HOURS_LEFT}.`,
    };
  }
  return { ok: true, value: parsed };
}

/** Purpose: resolve effective config with deterministic precedence: primary -> fallback -> hard defaults. */
export function resolveWarPlanComplianceConfig(input: {
  primary?: MaybeConfig | null;
  fallback?: MaybeConfig | null;
}): WarPlanComplianceConfig {
  const primaryMin = toSafeNonNegativeInt(input.primary?.nonMirrorTripleMinClanStars);
  const fallbackMin = toSafeNonNegativeInt(input.fallback?.nonMirrorTripleMinClanStars);
  const primaryHours = toSafeNonNegativeInt(input.primary?.allBasesOpenHoursLeft);
  const fallbackHours = toSafeNonNegativeInt(input.fallback?.allBasesOpenHoursLeft);

  const resolvedHoursBase =
    primaryHours ?? fallbackHours ?? DEFAULT_ALL_BASES_OPEN_HOURS_LEFT;
  const resolvedHours = Math.max(
    0,
    Math.min(MAX_ALL_BASES_OPEN_HOURS_LEFT, resolvedHoursBase)
  );

  return {
    nonMirrorTripleMinClanStars:
      primaryMin ?? fallbackMin ?? DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
    allBasesOpenHoursLeft: resolvedHours,
  };
}
