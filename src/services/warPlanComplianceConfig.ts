export const DEFAULT_NON_MIRROR_MIN_CLAN_STARS = 101;
export const DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS =
  DEFAULT_NON_MIRROR_MIN_CLAN_STARS;
export const DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS = 150;
export const DEFAULT_ALL_BASES_OPEN_HOURS_LEFT = 0;
export const DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT = 12;
export const MAX_ALL_BASES_OPEN_HOURS_LEFT = 24;

export type WarPlanComplianceConfig = {
  nonMirrorMinClanStars: number;
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
  traditionalRequireMirrorAfterOpen?: boolean;
};

type MaybeConfig = {
  nonMirrorMinClanStars?: number | null;
  nonMirrorTripleMinClanStars?: number | null;
  allBasesOpenHoursLeft?: number | null;
  traditionalRequireMirrorAfterOpen?: boolean | null;
};

type BuiltInFallback = {
  nonMirrorMinClanStars: number;
  allBasesOpenHoursLeft: number;
  traditionalRequireMirrorAfterOpen?: boolean;
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

function resolveNonMirrorMinClanStars(value: MaybeConfig | null | undefined): number | null {
  return toSafeNonNegativeInt(
    value?.nonMirrorMinClanStars ?? value?.nonMirrorTripleMinClanStars ?? null,
  );
}

function resolveTraditionalMirrorAfterOpen(
  value: MaybeConfig | null | undefined,
): boolean | null {
  if (value?.traditionalRequireMirrorAfterOpen === undefined || value.traditionalRequireMirrorAfterOpen === null) {
    return null;
  }
  return value.traditionalRequireMirrorAfterOpen;
}

/** Purpose: parse optional integer input for the non-mirror star gate; blank means unset/default. */
export function parseNonMirrorMinClanStarsInput(raw: string | null | undefined): ParseResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      error: "`clan stars before non-mirror opening` must be a non-negative integer.",
    };
  }
  const parsed = Math.trunc(Number(text));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ok: false,
      error: "`clan stars before non-mirror opening` must be a non-negative integer.",
    };
  }
  return { ok: true, value: parsed };
}

export const parseNonMirrorTripleMinClanStarsInput = parseNonMirrorMinClanStarsInput;

/** Purpose: parse optional `H`/`Hh` input for all-bases-open cutoff; blank means unset/default. */
export function parseAllBasesOpenHoursLeftInput(raw: string | null | undefined): ParseResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };

  const match = text.match(/^(\d+)(h)?$/i);
  if (!match) {
    return {
      ok: false,
      error:
        "`all bases open time cutoff` must be a non-negative integer hour value like `8` or `8h`.",
    };
  }

  const parsed = Math.trunc(Number(match[1]));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      ok: false,
      error:
        "`all bases open time cutoff` must be a non-negative integer hour value like `8` or `8h`.",
    };
  }
  if (parsed > MAX_ALL_BASES_OPEN_HOURS_LEFT) {
    return {
      ok: false,
      error: `\`all bases open time cutoff\` must be between 0 and ${MAX_ALL_BASES_OPEN_HOURS_LEFT}.`,
    };
  }
  return { ok: true, value: parsed };
}

/** Purpose: resolve effective config with deterministic precedence: primary -> fallback -> hard defaults. */
export function resolveWarPlanComplianceConfig(input: {
  primary?: MaybeConfig | null;
  fallback?: MaybeConfig | null;
  builtInFallback?: BuiltInFallback | null;
  includeTraditionalMirrorAfterOpen?: boolean;
}): WarPlanComplianceConfig {
  const primaryMin = resolveNonMirrorMinClanStars(input.primary);
  const fallbackMin = resolveNonMirrorMinClanStars(input.fallback);
  const primaryHours = toSafeNonNegativeInt(input.primary?.allBasesOpenHoursLeft);
  const fallbackHours = toSafeNonNegativeInt(input.fallback?.allBasesOpenHoursLeft);
  const primaryTraditionalMirror = input.includeTraditionalMirrorAfterOpen
    ? resolveTraditionalMirrorAfterOpen(input.primary)
    : null;
  const fallbackTraditionalMirror = input.includeTraditionalMirrorAfterOpen
    ? resolveTraditionalMirrorAfterOpen(input.fallback)
    : null;
  const builtInFallback = input.builtInFallback ?? {
    nonMirrorMinClanStars: DEFAULT_NON_MIRROR_MIN_CLAN_STARS,
    allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  };

  const resolvedHoursBase =
    primaryHours ?? fallbackHours ?? builtInFallback.allBasesOpenHoursLeft;
  const resolvedHours = Math.max(
    0,
    Math.min(MAX_ALL_BASES_OPEN_HOURS_LEFT, resolvedHoursBase)
  );
  const resolvedMin =
    primaryMin ?? fallbackMin ?? builtInFallback.nonMirrorMinClanStars;
  const resolvedTraditionalMirror =
    primaryTraditionalMirror ??
    fallbackTraditionalMirror ??
    (input.includeTraditionalMirrorAfterOpen
      ? builtInFallback.traditionalRequireMirrorAfterOpen
      : null) ??
    null;

  return {
    nonMirrorMinClanStars: resolvedMin,
    nonMirrorTripleMinClanStars: resolvedMin,
    allBasesOpenHoursLeft: resolvedHours,
    ...(resolvedTraditionalMirror === null
      ? {}
      : { traditionalRequireMirrorAfterOpen: resolvedTraditionalMirror }),
  };
}

export function resolveWarPlanComplianceConfigForPlan(input: {
  primary?: MaybeConfig | null;
  fallback?: MaybeConfig | null;
  matchType: string | null | undefined;
  expectedOutcome: string | null | undefined;
  loseStyle?: string | null | undefined;
}): WarPlanComplianceConfig | null {
  const matchType = String(input.matchType ?? "").toUpperCase();
  const expectedOutcome = String(input.expectedOutcome ?? "").toUpperCase();
  const loseStyle = String(input.loseStyle ?? "").toUpperCase();

  if (matchType !== "FWA") return null;
  if (expectedOutcome === "WIN") {
    return resolveWarPlanComplianceConfig({
      primary: input.primary,
      fallback: input.fallback,
      builtInFallback: {
        nonMirrorMinClanStars: DEFAULT_NON_MIRROR_MIN_CLAN_STARS,
        allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
      },
    });
  }

  if (expectedOutcome === "LOSE" && loseStyle === "TRADITIONAL") {
    return resolveWarPlanComplianceConfig({
      primary: input.primary,
      fallback: input.fallback,
      builtInFallback: {
        nonMirrorMinClanStars:
          DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
        allBasesOpenHoursLeft: DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT,
        traditionalRequireMirrorAfterOpen: false,
      },
      includeTraditionalMirrorAfterOpen: true,
    });
  }

  return null;
}

export function formatWarPlanComplianceLine(input: {
  matchType: string | null | undefined;
  expectedOutcome: string | null | undefined;
  loseStyle?: string | null | undefined;
  config: WarPlanComplianceConfig | null;
}): string | null {
  const matchType = String(input.matchType ?? "").toUpperCase();
  const expectedOutcome = String(input.expectedOutcome ?? "").toUpperCase();
  const loseStyle = String(input.loseStyle ?? "").toUpperCase();

  if (matchType !== "FWA") {
    return "Automated warplan compliance is disabled.";
  }

  if (expectedOutcome === "WIN") {
    if (!input.config) return "Automated warplan compliance is disabled.";
    return `Compliance gate: non-mirror 3★ opens at ${input.config.nonMirrorMinClanStars} clan stars or ${input.config.allBasesOpenHoursLeft}h left`;
  }

  if (expectedOutcome === "LOSE" && loseStyle === "TRADITIONAL") {
    const minClanStars =
      input.config?.nonMirrorMinClanStars ??
      DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS;
    const openHoursLeft =
      input.config?.allBasesOpenHoursLeft ??
      DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT;
    const mirrorAfterOpen =
      input.config?.traditionalRequireMirrorAfterOpen === true
        ? "required"
        : "not required";
    return `Compliance gate: open at ${minClanStars} clan stars or ${openHoursLeft}h left | open attacks: 0-2★ any | uncleared mirror after open: ${mirrorAfterOpen} | clan cap: 100★`;
  }

  if (expectedOutcome === "LOSE" && loseStyle === "TRIPLE_TOP_30") {
    return "Compliance rules: targets #1-30 only | attacks must earn 1-3★ | clan cap: 90★";
  }

  return "Automated warplan compliance is disabled.";
}
