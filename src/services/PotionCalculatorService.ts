/** Purpose: describe the stateless potion types supported by the calculator. */
export type PotionType = "builder" | "research" | "pet" | "clocktower";

/** Purpose: capture the fixed potion configuration used by the calculator. */
export type PotionConfig = {
  label: string;
  speedMultiplier: number;
  boostSecondsPerPotion: number;
};

/** Purpose: represent a parsed upgrade duration in whole seconds. */
export type PotionDurationParseResult =
  | { kind: "valid"; totalSeconds: number }
  | { kind: "invalid"; message: string };

/** Purpose: represent the explicit-count potion calculation outcome. */
export type PotionCalculationResult =
  | {
      kind: "valid";
      type: PotionType;
      typeLabel: string;
      speedMultiplier: number;
      boostSecondsPerPotion: number;
      numPots: number;
      originalTimeLeftSeconds: number;
      originalTimeLeftDisplay: string;
      /** Newly added potion duration; active boost time is exposed separately when supplied. */
      boostWindowSeconds: number;
      boostRemainingSeconds?: number;
      boostRemainingDisplay?: string;
      effectiveBoostWindowSeconds?: number;
      completionDurationSeconds: number;
      completionDurationDisplay: string;
      completionAt: Date;
      completionUnixSeconds: number;
      timeSavedSeconds: number;
      timeSavedDisplay: string;
      helperLevel?: number;
      helperNextInSeconds?: number;
      helperNextInDisplay?: string;
    }
  | { kind: "invalid"; message: string };

/** Purpose: represent one deterministic recommendation scenario. */
export type PotionRecommendationScenario = {
  numPots: number;
  boostWindowSeconds: number;
  effectiveBoostWindowSeconds: number;
  completionDurationSeconds: number;
  completionDurationDisplay: string;
  completionAt: Date;
  completionUnixSeconds: number;
  timeSavedSeconds: number;
  timeSavedDisplay: string;
  upgradeTimeRemainingAtBoostExpirySeconds: number;
  upgradeTimeRemainingAtBoostExpiryDisplay: string;
  potionBoostRemainingAtCompletionSeconds: number;
  potionBoostRemainingAtCompletionDisplay: string;
};

/** Purpose: represent the distinct automatic potion recommendation result. */
export type PotionRecommendationResult =
  | {
      kind: "recommendation";
      type: PotionType;
      typeLabel: string;
      speedMultiplier: number;
      boostSecondsPerPotion: number;
      originalTimeLeftSeconds: number;
      originalTimeLeftDisplay: string;
      boostRemainingSeconds?: number;
      boostRemainingDisplay?: string;
      recommendedNumPots: number;
      recommendedScenario: PotionRecommendationScenario;
      previousScenario?: PotionRecommendationScenario;
      helperLevel?: number;
      helperNextInSeconds?: number;
      helperNextInDisplay?: string;
    }
  | { kind: "invalid"; message: string };

/** Purpose: unify explicit and automatic calculator outcomes for callers that omit num-pots. */
export type PotionResult = PotionCalculationResult | PotionRecommendationResult;

/** Purpose: surface the validation hint for malformed time-left input. */
export const POTION_TIME_LEFT_INVALID_MESSAGE =
  "Invalid time-left. Use a duration like 3d12h45m, 12h30m, or 45m.";

/** Purpose: surface the validation hint for malformed potion counts. */
export const POTION_NUM_POTS_INVALID_MESSAGE =
  "Invalid num-pots. Use an integer between 1 and 100.";

/** Purpose: surface the validation hint for malformed active boost time. */
export const POTION_BOOST_REMAINING_INVALID_MESSAGE =
  "Invalid boost-remaining. Use a positive duration like 3d12h45m, 12h30m, or 45m.";

/** Purpose: surface the validation hint for malformed helper levels. */
export const POTION_HELPER_LEVEL_INVALID_MESSAGE =
  "Invalid helper-level. Builder's Apprentice uses levels 1-8; Lab Assistant uses levels 1-12.";

/** Purpose: surface the validation hint for helper use with unsupported potion types. */
export const POTION_HELPER_INCOMPATIBLE_MESSAGE =
  "Helper arguments are only supported for Builder Potion and Research Potion.";

/** Purpose: surface the validation hint for helper-next-in without helper-level. */
export const POTION_HELPER_LEVEL_REQUIRED_MESSAGE =
  "helper-next-in requires helper-level.";

/** Purpose: surface the validation hint for helper-next-in input. */
export const POTION_HELPER_NEXT_IN_INVALID_MESSAGE =
  "Invalid helper-next-in. Use 0m or a duration like 1h30m.";

/** Purpose: explain that automatic recommendations retain the existing potion limit. */
export const POTION_RECOMMENDATION_LIMIT_MESSAGE =
  "This upgrade would require more than 100 additional potions; the calculator supports at most 100.";

const MAX_SAFE_SECONDS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_SECONDS_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DURATION_TOKEN_RE = /\s*(\d+)\s*([dhm])\s*/iy;
const HELPER_WORK_SECONDS = 60 * 60;
const HELPER_CYCLE_SECONDS = 23 * 60 * 60;

const POTION_CONFIGS: Record<PotionType, PotionConfig> = {
  builder: {
    label: "Builder Potion",
    speedMultiplier: 10,
    boostSecondsPerPotion: 60 * 60,
  },
  research: {
    label: "Research Potion",
    speedMultiplier: 24,
    boostSecondsPerPotion: 60 * 60,
  },
  pet: {
    label: "Pet Potion",
    speedMultiplier: 24,
    boostSecondsPerPotion: 60 * 60,
  },
  clocktower: {
    label: "Clock Tower Potion",
    speedMultiplier: 10,
    boostSecondsPerPotion: 30 * 60,
  },
};

type ValidatedInput = {
  config: PotionConfig;
  nowMs: number;
  originalTimeLeftSeconds: number;
  boostRemainingSeconds?: number;
  helperLevel?: number;
  helperNextInSeconds?: number;
};

type PotionScenarioCalculation = PotionRecommendationScenario & {
  originalTimeLeftSeconds: number;
};

type InvalidCalculation = { kind: "invalid"; message: string };

/** Purpose: narrow internal validation/scenario unions without adding a result owner. */
function isInvalidCalculation(value: unknown): value is InvalidCalculation {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "invalid"
  );
}

/** Purpose: resolve the fixed calculator config for a given potion type. */
export function getPotionConfig(type: PotionType): PotionConfig {
  return POTION_CONFIGS[type];
}

/** Purpose: parse a compact or spaced duration string into whole seconds. */
export function parsePotionDuration(
  input: string,
  invalidMessage = POTION_TIME_LEFT_INVALID_MESSAGE,
  allowZero = false,
): PotionDurationParseResult {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (!normalized) {
    return { kind: "invalid", message: invalidMessage };
  }

  let totalSeconds = 0n;
  let tokenCount = 0;
  let lastUnitRank = -1;
  let cursor = 0;

  while (cursor < normalized.length) {
    DURATION_TOKEN_RE.lastIndex = cursor;
    const match = DURATION_TOKEN_RE.exec(normalized);
    if (!match || match.index !== cursor) {
      return { kind: "invalid", message: invalidMessage };
    }

    const amountText = match[1] ?? "";
    const unit = (match[2] ?? "") as "d" | "h" | "m";
    const unitRank = unit === "d" ? 0 : unit === "h" ? 1 : 2;
    if (unitRank <= lastUnitRank) {
      return { kind: "invalid", message: invalidMessage };
    }
    lastUnitRank = unitRank;

    let amount: bigint;
    try {
      amount = BigInt(amountText);
    } catch {
      return { kind: "invalid", message: invalidMessage };
    }

    const unitSeconds = unit === "d" ? 86_400n : unit === "h" ? 3_600n : 60n;
    totalSeconds += amount * unitSeconds;
    if (totalSeconds > MAX_SAFE_SECONDS) {
      return { kind: "invalid", message: invalidMessage };
    }

    tokenCount += 1;
    cursor = DURATION_TOKEN_RE.lastIndex;
  }

  if (tokenCount <= 0 || (!allowZero && totalSeconds <= 0n)) {
    return { kind: "invalid", message: invalidMessage };
  }

  return { kind: "valid", totalSeconds: Number(totalSeconds) };
}

/** Purpose: format a duration with non-zero days, hours, minutes, and seconds. */
export function formatPotionDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "0s";

  let remaining = Math.max(0, Math.trunc(totalSeconds));
  const days = Math.trunc(remaining / 86_400);
  remaining -= days * 86_400;
  const hours = Math.trunc(remaining / 3_600);
  remaining -= hours * 3_600;
  const minutes = Math.trunc(remaining / 60);
  remaining -= minutes * 60;
  const seconds = remaining;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.length > 0 ? parts.join(" ") : "0s";
}

/** Purpose: validate shared duration, date, boost, and optional helper arguments once. */
function validateInput(input: {
  type: PotionType;
  timeLeft: string;
  boostRemaining?: string | null;
  helperLevel?: number | null;
  helperNextIn?: string | null;
  now: Date;
}): ValidatedInput | { kind: "invalid"; message: string } {
  const config = getPotionConfig(input.type);
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }

  const parsedTimeLeft = parsePotionDuration(input.timeLeft);
  if (parsedTimeLeft.kind === "invalid") {
    return parsedTimeLeft;
  }

  let boostRemainingSeconds: number | undefined;
  if (input.boostRemaining !== undefined && input.boostRemaining !== null) {
    const boostRemaining = parsePotionDuration(
      input.boostRemaining,
      POTION_BOOST_REMAINING_INVALID_MESSAGE,
    );
    if (boostRemaining.kind === "invalid") {
      return boostRemaining;
    }
    boostRemainingSeconds = boostRemaining.totalSeconds;
  }

  const hasHelperLevel = input.helperLevel !== undefined && input.helperLevel !== null;
  const hasHelperNextIn = input.helperNextIn !== undefined && input.helperNextIn !== null;
  if ((hasHelperLevel || hasHelperNextIn) && (input.type === "pet" || input.type === "clocktower")) {
    return { kind: "invalid", message: POTION_HELPER_INCOMPATIBLE_MESSAGE };
  }
  if (hasHelperNextIn && !hasHelperLevel) {
    return { kind: "invalid", message: POTION_HELPER_LEVEL_REQUIRED_MESSAGE };
  }

  let helperLevel: number | undefined;
  let helperNextInSeconds: number | undefined;
  if (hasHelperLevel) {
    helperLevel = input.helperLevel as number;
    const maxLevel = input.type === "builder" ? 8 : 12;
    if (!Number.isInteger(helperLevel) || helperLevel < 1 || helperLevel > maxLevel) {
      return { kind: "invalid", message: POTION_HELPER_LEVEL_INVALID_MESSAGE };
    }

    if (hasHelperNextIn) {
      const parsedNextIn = parsePotionDuration(
        input.helperNextIn as string,
        POTION_HELPER_NEXT_IN_INVALID_MESSAGE,
        true,
      );
      if (parsedNextIn.kind === "invalid") {
        return parsedNextIn;
      }
      helperNextInSeconds = parsedNextIn.totalSeconds;
    } else {
      helperNextInSeconds = 0;
    }
  }

  return {
    config,
    nowMs,
    originalTimeLeftSeconds: parsedTimeLeft.totalSeconds,
    ...(boostRemainingSeconds === undefined ? {} : { boostRemainingSeconds }),
    ...(helperLevel === undefined ? {} : { helperLevel, helperNextInSeconds }),
  };
}

/** Purpose: count helper-active seconds in [0, end) without per-second simulation. */
function helperWorkSecondsUntil(endSeconds: number, helperNextInSeconds: number): number {
  if (endSeconds <= helperNextInSeconds) return 0;

  const elapsed = endSeconds - helperNextInSeconds;
  const completeCycles = Math.floor(elapsed / HELPER_CYCLE_SECONDS);
  const cycleRemainder = elapsed - completeCycles * HELPER_CYCLE_SECONDS;
  return completeCycles * HELPER_WORK_SECONDS + Math.min(cycleRemainder, HELPER_WORK_SECONDS);
}

/** Purpose: calculate additive upgrade progress at a time boundary. */
function progressAt(
  endSeconds: number,
  input: ValidatedInput,
  effectiveBoostWindowSeconds: number,
): number {
  const potionSeconds = Math.min(endSeconds, effectiveBoostWindowSeconds);
  const potionProgress = potionSeconds * (input.config.speedMultiplier - 1);
  const helperProgress =
    input.helperLevel === undefined
      ? 0
      : helperWorkSecondsUntil(endSeconds, input.helperNextInSeconds ?? 0) * input.helperLevel;
  return endSeconds + potionProgress + helperProgress;
}

/** Purpose: find the first whole-second estimate at which the additive model completes. */
function calculateHelperCompletionDuration(
  input: ValidatedInput,
  effectiveBoostWindowSeconds: number,
): number {
  let upperBound = 1;
  while (progressAt(upperBound, input, effectiveBoostWindowSeconds) < input.originalTimeLeftSeconds) {
    if (upperBound >= MAX_SAFE_SECONDS_NUMBER) {
      return MAX_SAFE_SECONDS_NUMBER;
    }
    upperBound = Math.min(MAX_SAFE_SECONDS_NUMBER, upperBound * 2);
  }

  let lowerBound = 0;
  while (lowerBound < upperBound) {
    const midpoint = lowerBound + Math.floor((upperBound - lowerBound) / 2);
    if (progressAt(midpoint, input, effectiveBoostWindowSeconds) >= input.originalTimeLeftSeconds) {
      upperBound = midpoint;
    } else {
      lowerBound = midpoint + 1;
    }
  }
  return lowerBound;
}

/** Purpose: build a completion timestamp while preserving the existing date safety checks. */
function buildCompletionTimestamp(
  nowMs: number,
  completionDurationSeconds: number,
): { kind: "valid"; completionAt: Date; completionUnixSeconds: number } | { kind: "invalid"; message: string } {
  const completionAtMs = nowMs + completionDurationSeconds * 1000;
  if (!Number.isFinite(completionAtMs) || Math.abs(completionAtMs) > MAX_DATE_MS) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }
  const completionAt = new Date(completionAtMs);
  if (!Number.isFinite(completionAt.getTime())) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }
  return {
    kind: "valid",
    completionAt,
    completionUnixSeconds: Math.ceil(completionAtMs / 1000),
  };
}

/** Purpose: calculate one count scenario using the common additive progress model. */
function calculateScenario(
  input: ValidatedInput,
  numPots: number,
): PotionScenarioCalculation | { kind: "invalid"; message: string } {
  const boostWindowSeconds = numPots * input.config.boostSecondsPerPotion;
  const effectiveBoostWindowSeconds = boostWindowSeconds + (input.boostRemainingSeconds ?? 0);
  if (!Number.isSafeInteger(effectiveBoostWindowSeconds)) {
    return { kind: "invalid", message: POTION_BOOST_REMAINING_INVALID_MESSAGE };
  }

  const completionDurationSeconds =
    input.helperLevel === undefined
      ? input.originalTimeLeftSeconds <= effectiveBoostWindowSeconds * input.config.speedMultiplier
        ? Math.ceil(input.originalTimeLeftSeconds / input.config.speedMultiplier)
        : effectiveBoostWindowSeconds +
          (input.originalTimeLeftSeconds - effectiveBoostWindowSeconds * input.config.speedMultiplier)
      : calculateHelperCompletionDuration(input, effectiveBoostWindowSeconds);
  const timestamp = buildCompletionTimestamp(input.nowMs, completionDurationSeconds);
  if (timestamp.kind === "invalid") {
    return timestamp;
  }

  const progressAtBoostExpiry = progressAt(
    effectiveBoostWindowSeconds,
    input,
    effectiveBoostWindowSeconds,
  );
  const upgradeTimeRemainingAtBoostExpirySeconds = Math.max(
    0,
    input.originalTimeLeftSeconds - progressAtBoostExpiry,
  );
  const potionBoostRemainingAtCompletionSeconds = Math.max(
    0,
    effectiveBoostWindowSeconds - completionDurationSeconds,
  );
  const timeSavedSeconds = input.originalTimeLeftSeconds - completionDurationSeconds;

  return {
    originalTimeLeftSeconds: input.originalTimeLeftSeconds,
    numPots,
    boostWindowSeconds,
    effectiveBoostWindowSeconds,
    completionDurationSeconds,
    completionDurationDisplay: formatPotionDuration(completionDurationSeconds),
    completionAt: timestamp.completionAt,
    completionUnixSeconds: timestamp.completionUnixSeconds,
    timeSavedSeconds,
    timeSavedDisplay: formatPotionDuration(timeSavedSeconds),
    upgradeTimeRemainingAtBoostExpirySeconds,
    upgradeTimeRemainingAtBoostExpiryDisplay: formatPotionDuration(
      upgradeTimeRemainingAtBoostExpirySeconds,
    ),
    potionBoostRemainingAtCompletionSeconds,
    potionBoostRemainingAtCompletionDisplay: formatPotionDuration(
      potionBoostRemainingAtCompletionSeconds,
    ),
  };
}

/** Purpose: calculate when the selected upgrade completes if potions are activated now. */
export function calculatePotionCompletion(input: {
  type: PotionType;
  timeLeft: string;
  numPots?: number | null;
  boostRemaining?: string | null;
  helperLevel?: number | null;
  helperNextIn?: string | null;
  now: Date;
}): PotionResult {
  if (input.numPots === undefined || input.numPots === null) {
    return calculatePotionRecommendation(input);
  }

  if (!Number.isInteger(input.numPots) || input.numPots < 1 || input.numPots > 100) {
    return { kind: "invalid", message: POTION_NUM_POTS_INVALID_MESSAGE };
  }

  const validated = validateInput(input);
  if (isInvalidCalculation(validated)) {
    return validated;
  }

  const scenario = calculateScenario(validated, input.numPots);
  if (isInvalidCalculation(scenario)) {
    return scenario;
  }

  return {
    kind: "valid",
    type: input.type,
    typeLabel: validated.config.label,
    speedMultiplier: validated.config.speedMultiplier,
    boostSecondsPerPotion: validated.config.boostSecondsPerPotion,
    numPots: input.numPots,
    originalTimeLeftSeconds: validated.originalTimeLeftSeconds,
    originalTimeLeftDisplay: formatPotionDuration(validated.originalTimeLeftSeconds),
    boostWindowSeconds: scenario.boostWindowSeconds,
    ...(validated.boostRemainingSeconds === undefined
      ? {}
      : {
          boostRemainingSeconds: validated.boostRemainingSeconds,
          boostRemainingDisplay: formatPotionDuration(validated.boostRemainingSeconds),
          effectiveBoostWindowSeconds: scenario.effectiveBoostWindowSeconds,
        }),
    completionDurationSeconds: scenario.completionDurationSeconds,
    completionDurationDisplay: scenario.completionDurationDisplay,
    completionAt: scenario.completionAt,
    completionUnixSeconds: scenario.completionUnixSeconds,
    timeSavedSeconds: scenario.timeSavedSeconds,
    timeSavedDisplay: scenario.timeSavedDisplay,
    ...(validated.helperLevel === undefined
      ? {}
      : {
          helperLevel: validated.helperLevel,
          helperNextInSeconds: validated.helperNextInSeconds,
          helperNextInDisplay: formatPotionDuration(validated.helperNextInSeconds ?? 0),
        }),
  };
}

/** Purpose: recommend the minimum additional potion count that completes within the boosted window. */
export function calculatePotionRecommendation(input: {
  type: PotionType;
  timeLeft: string;
  boostRemaining?: string | null;
  helperLevel?: number | null;
  helperNextIn?: string | null;
  now: Date;
}): PotionRecommendationResult {
  const validated = validateInput(input);
  if (isInvalidCalculation(validated)) {
    return validated;
  }

  let recommendedScenario: PotionScenarioCalculation | undefined;
  let recommendedNumPots = -1;
  for (let numPots = 0; numPots <= 100; numPots += 1) {
    const scenario = calculateScenario(validated, numPots);
    if (isInvalidCalculation(scenario)) {
      return scenario;
    }
    if (
      progressAt(
        scenario.effectiveBoostWindowSeconds,
        validated,
        scenario.effectiveBoostWindowSeconds,
      ) >= validated.originalTimeLeftSeconds
    ) {
      recommendedScenario = scenario;
      recommendedNumPots = numPots;
      break;
    }
  }

  if (!recommendedScenario || recommendedNumPots < 0) {
    return { kind: "invalid", message: POTION_RECOMMENDATION_LIMIT_MESSAGE };
  }

  let previousScenario: PotionRecommendationScenario | undefined;
  if (recommendedNumPots > 0) {
    const previous = calculateScenario(validated, recommendedNumPots - 1);
    if (isInvalidCalculation(previous)) {
      return previous;
    }
    previousScenario = previous;
  }

  return {
    kind: "recommendation",
    type: input.type,
    typeLabel: validated.config.label,
    speedMultiplier: validated.config.speedMultiplier,
    boostSecondsPerPotion: validated.config.boostSecondsPerPotion,
    originalTimeLeftSeconds: validated.originalTimeLeftSeconds,
    originalTimeLeftDisplay: formatPotionDuration(validated.originalTimeLeftSeconds),
    ...(validated.boostRemainingSeconds === undefined
      ? {}
      : {
          boostRemainingSeconds: validated.boostRemainingSeconds,
          boostRemainingDisplay: formatPotionDuration(validated.boostRemainingSeconds),
        }),
    recommendedNumPots,
    recommendedScenario,
    ...(previousScenario === undefined ? {} : { previousScenario }),
    ...(validated.helperLevel === undefined
      ? {}
      : {
          helperLevel: validated.helperLevel,
          helperNextInSeconds: validated.helperNextInSeconds,
          helperNextInDisplay: formatPotionDuration(validated.helperNextInSeconds ?? 0),
        }),
  };
}
