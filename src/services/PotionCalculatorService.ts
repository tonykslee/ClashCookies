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

/** Purpose: represent the stateless potion calculation outcome. */
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
      boostWindowSeconds: number;
      completionDurationSeconds: number;
      completionDurationDisplay: string;
      completionAt: Date;
      completionUnixSeconds: number;
      timeSavedSeconds: number;
      timeSavedDisplay: string;
    }
  | { kind: "invalid"; message: string };

/** Purpose: surface the validation hint for malformed time-left input. */
export const POTION_TIME_LEFT_INVALID_MESSAGE =
  "Invalid time-left. Use a duration like 3d12h45m, 12h30m, or 45m.";

/** Purpose: surface the validation hint for malformed potion counts. */
export const POTION_NUM_POTS_INVALID_MESSAGE =
  "Invalid num-pots. Use an integer between 1 and 100.";

const MAX_SAFE_SECONDS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DATE_MS = 8_640_000_000_000_000;
const DURATION_TOKEN_RE = /\s*(\d+)\s*([dhm])\s*/iy;

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

/** Purpose: resolve the fixed calculator config for a given potion type. */
export function getPotionConfig(type: PotionType): PotionConfig {
  return POTION_CONFIGS[type];
}

/** Purpose: parse a compact or spaced duration string into whole seconds. */
export function parsePotionDuration(input: string): PotionDurationParseResult {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (!normalized) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }

  let totalSeconds = 0n;
  let tokenCount = 0;
  let lastUnitRank = -1;
  let cursor = 0;

  while (cursor < normalized.length) {
    DURATION_TOKEN_RE.lastIndex = cursor;
    const match = DURATION_TOKEN_RE.exec(normalized);
    if (!match || match.index !== cursor) {
      return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
    }

    const amountText = match[1] ?? "";
    const unit = (match[2] ?? "") as "d" | "h" | "m";
    const unitRank = unit === "d" ? 0 : unit === "h" ? 1 : 2;
    if (unitRank <= lastUnitRank) {
      return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
    }
    lastUnitRank = unitRank;

    let amount: bigint;
    try {
      amount = BigInt(amountText);
    } catch {
      return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
    }

    const unitSeconds = unit === "d" ? 86_400n : unit === "h" ? 3_600n : 60n;
    totalSeconds += amount * unitSeconds;
    if (totalSeconds > MAX_SAFE_SECONDS) {
      return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
    }

    tokenCount += 1;
    cursor = DURATION_TOKEN_RE.lastIndex;
  }

  if (tokenCount <= 0 || totalSeconds <= 0n) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
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

/** Purpose: calculate when the selected upgrade completes if potions are activated now. */
export function calculatePotionCompletion(input: {
  type: PotionType;
  timeLeft: string;
  numPots: number;
  now: Date;
}): PotionCalculationResult {
  const config = getPotionConfig(input.type);
  if (!Number.isInteger(input.numPots) || input.numPots < 1 || input.numPots > 100) {
    return { kind: "invalid", message: POTION_NUM_POTS_INVALID_MESSAGE };
  }

  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }

  const parsed = parsePotionDuration(input.timeLeft);
  if (parsed.kind === "invalid") {
    return parsed;
  }

  const originalTimeLeftSeconds = parsed.totalSeconds;
  const boostWindowSeconds = input.numPots * config.boostSecondsPerPotion;
  const boostedWorkCapacity = boostWindowSeconds * config.speedMultiplier;
  const completionDurationSeconds =
    originalTimeLeftSeconds <= boostedWorkCapacity
      ? Math.ceil(originalTimeLeftSeconds / config.speedMultiplier)
      : boostWindowSeconds + (originalTimeLeftSeconds - boostedWorkCapacity);
  const completionAtMs = nowMs + completionDurationSeconds * 1000;
  if (!Number.isFinite(completionAtMs) || Math.abs(completionAtMs) > MAX_DATE_MS) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }
  const completionAt = new Date(completionAtMs);
  if (!Number.isFinite(completionAt.getTime())) {
    return { kind: "invalid", message: POTION_TIME_LEFT_INVALID_MESSAGE };
  }
  const timeSavedSeconds = originalTimeLeftSeconds - completionDurationSeconds;

  return {
    kind: "valid",
    type: input.type,
    typeLabel: config.label,
    speedMultiplier: config.speedMultiplier,
    boostSecondsPerPotion: config.boostSecondsPerPotion,
    numPots: input.numPots,
    originalTimeLeftSeconds,
    originalTimeLeftDisplay: formatPotionDuration(originalTimeLeftSeconds),
    boostWindowSeconds,
    completionDurationSeconds,
    completionDurationDisplay: formatPotionDuration(completionDurationSeconds),
    completionAt,
    completionUnixSeconds: Math.ceil(completionAtMs / 1000),
    timeSavedSeconds,
    timeSavedDisplay: formatPotionDuration(timeSavedSeconds),
  };
}
