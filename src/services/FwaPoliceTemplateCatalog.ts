import type { ApplicationCommandOptionChoiceData } from "discord.js";
import { type WarComplianceIssue } from "./WarComplianceService";
import {
  TRADITIONAL_STRICT_MIRROR_CLEANUP_REASON,
  TRADITIONAL_UNCLEARED_MIRROR_AFTER_OPEN_REASON,
  type FwaLoseStyle,
  type MatchType,
} from "./war-events/core";

export const FWA_POLICE_VIOLATIONS = [
  "EARLY_NON_MIRROR_TRIPLE",
  "STRICT_WINDOW_MIRROR_MISS_WIN",
  "STRICT_WINDOW_MIRROR_MISS_LOSS",
  "EARLY_NON_MIRROR_2STAR",
  "TRADITIONAL_INVALID_STAR_COUNT",
  "TRADITIONAL_INVALID_CLEANUP_TARGET",
  "TRADITIONAL_UNCLEARED_MIRROR",
  "ANY_3STAR",
  "LOWER20_ANY_STARS",
  "CLAN_STAR_CAP_EXCEEDED",
  "TOP30_ZERO_STARS",
] as const;

export type FwaPoliceEnforcementViolation = (typeof FWA_POLICE_VIOLATIONS)[number];
export type FwaPoliceViolation = Exclude<
  FwaPoliceEnforcementViolation,
  "TRADITIONAL_INVALID_CLEANUP_TARGET" | "TRADITIONAL_UNCLEARED_MIRROR"
>;

export type FwaPoliceApplicabilityContext = {
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
};

export type FwaPoliceViolationMetadata = {
  label: string;
  builtInTemplate: string;
  isApplicable: (context: FwaPoliceApplicabilityContext) => boolean;
};

const PLACEHOLDER_REGEX = /\{([a-zA-Z0-9_]+)\}/g;

/** Purpose: shared preview offender text used for sample rendering paths. */
export const FWA_POLICE_SAMPLE_OFFENDER = "#15 - Tilonius";

/** Purpose: normalize arbitrary text into one deterministic line-safe value. */
export function normalizeFwaPoliceText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Purpose: build slash-command choices directly from canonical violation values. */
export const FWA_POLICE_VIOLATION_CHOICES: ApplicationCommandOptionChoiceData<string>[] =
  FWA_POLICE_VIOLATIONS.map((value) => ({
    name: value,
    value,
  }));

/** Purpose: expose canonical metadata (label/template/applicability) for every supported police violation. */
export const FWA_POLICE_VIOLATION_METADATA: Record<
  FwaPoliceEnforcementViolation,
  FwaPoliceViolationMetadata
> = {
  EARLY_NON_MIRROR_TRIPLE: {
    label: "Early non-mirror triple before FFA window",
    builtInTemplate:
      "{offender} made an early non-mirror triple before the FFA window. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" && context.expectedOutcome === "WIN",
  },
  STRICT_WINDOW_MIRROR_MISS_WIN: {
    label: "Mirror missed during strict window (win)",
    builtInTemplate:
      "{offender} missed a required mirror triple during the strict window. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" && context.expectedOutcome === "WIN",
  },
  STRICT_WINDOW_MIRROR_MISS_LOSS: {
    label: "Mirror missed during strict window (loss)",
    builtInTemplate:
      "{offender} missed the strict-window mirror requirement in a loss-traditional flow. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  EARLY_NON_MIRROR_2STAR: {
    label: "Early non-mirror 2-star in traditional loss",
    builtInTemplate:
      "{offender} took an early non-mirror 2-star in traditional loss. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  TRADITIONAL_INVALID_STAR_COUNT: {
    label: "Invalid star count in traditional loss",
    builtInTemplate:
      "{offender} used an invalid star count in traditional loss. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  TRADITIONAL_INVALID_CLEANUP_TARGET: {
    label: "Strict cleanup attack used on own mirror",
    builtInTemplate:
      "{offender} used their strict-window cleanup attack on their own mirror instead of a non-mirror base. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  TRADITIONAL_UNCLEARED_MIRROR: {
    label: "Required mirror uncleared after open",
    builtInTemplate:
      "{offender} finished their attacks without clearing the required 2-star mirror after the open window. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  ANY_3STAR: {
    label: "Any 3-star in FWA loss (traditional)",
    builtInTemplate:
      "{offender} recorded a 3-star in a traditional FWA-loss plan. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRADITIONAL",
  },
  LOWER20_ANY_STARS: {
    label: "Attack on a lower-20 base in triple-top-30 loss",
    builtInTemplate:
      "{offender} attacked a lower-20 base in triple-top-30 loss mode. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRIPLE_TOP_30",
  },
  CLAN_STAR_CAP_EXCEEDED: {
    label: "Clan star cap exceeded",
    builtInTemplate:
      "{offender} pushed the clan past the star cap. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      (context.loseStyle === "TRADITIONAL" ||
        context.loseStyle === "TRIPLE_TOP_30"),
  },
  TOP30_ZERO_STARS: {
    label: "0-star attack on a top-30 base",
    builtInTemplate:
      "{offender} scored 0 stars on a top-30 base in triple-top-30 loss mode. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRIPLE_TOP_30",
  },
};

const CANONICAL_REASON_LABEL_TO_VIOLATION: Record<
  string,
  FwaPoliceEnforcementViolation
> = {
  "tripled non-mirror in strict window": "EARLY_NON_MIRROR_TRIPLE",
  "didn't triple mirror": "STRICT_WINDOW_MIRROR_MISS_WIN",
  "strict-window mirror miss in traditional loss":
    "STRICT_WINDOW_MIRROR_MISS_LOSS",
  [TRADITIONAL_STRICT_MIRROR_CLEANUP_REASON]:
    "TRADITIONAL_INVALID_CLEANUP_TARGET",
  [TRADITIONAL_UNCLEARED_MIRROR_AFTER_OPEN_REASON]:
    "TRADITIONAL_UNCLEARED_MIRROR",
  "early non-mirror 2-star in traditional loss": "EARLY_NON_MIRROR_2STAR",
  "invalid star count in traditional loss": "TRADITIONAL_INVALID_STAR_COUNT",
  "any 3-star in traditional loss": "ANY_3STAR",
  "attack on a lower-20 base": "LOWER20_ANY_STARS",
  "0-star attack on a top-30 base": "TOP30_ZERO_STARS",
  "clan star cap exceeded": "CLAN_STAR_CAP_EXCEEDED",
};

/** Purpose: render a police template with deterministic placeholder replacements. */
export function renderFwaPoliceTemplate(input: {
  template: string;
  offender: string;
  user: string;
}): string {
  return input.template.replace(PLACEHOLDER_REGEX, (_raw, keyRaw: string) => {
    const key = normalizeFwaPoliceText(keyRaw).toLowerCase();
    if (key === "offender") return input.offender;
    if (key === "user") return input.user;
    return `{${keyRaw}}`;
  });
}

function classifyUsingCanonicalReasonLabel(
  labelRaw: string,
): FwaPoliceEnforcementViolation | null {
  const label = normalizeFwaPoliceText(labelRaw).toLowerCase();
  if (!label) return null;
  return CANONICAL_REASON_LABEL_TO_VIOLATION[label] ?? null;
}

function classifyUsingReasonLabel(
  labelRaw: string,
): FwaPoliceEnforcementViolation | null {
  const label = normalizeFwaPoliceText(labelRaw).toLowerCase();
  if (!label) return null;
  if (label.includes("cap exceeded") || label.includes("star cap")) return "CLAN_STAR_CAP_EXCEEDED";
  if (label.includes("0-star") && label.includes("top-30")) return "TOP30_ZERO_STARS";
  if (label.includes("lower-20")) return "LOWER20_ANY_STARS";
  if (label.includes("tripled non-mirror")) return "EARLY_NON_MIRROR_TRIPLE";
  if (label.includes("didn't triple mirror")) return "STRICT_WINDOW_MIRROR_MISS_WIN";
  if (label.includes("early non-mirror 2-star")) return "EARLY_NON_MIRROR_2STAR";
  if (label.includes("invalid star count")) return "TRADITIONAL_INVALID_STAR_COUNT";
  if (label.includes("mirror 2-star")) return "STRICT_WINDOW_MIRROR_MISS_LOSS";
  if (label.includes("lose-style")) return "STRICT_WINDOW_MIRROR_MISS_LOSS";
  return null;
}

function isViolationApplicableToContext(
  violation: FwaPoliceEnforcementViolation,
  context: FwaPoliceApplicabilityContext,
): boolean {
  return FWA_POLICE_VIOLATION_METADATA[violation].isApplicable(context);
}

function isMirrorAttack(
  issue: WarComplianceIssue,
  defenderPosition: number | null,
): boolean {
  const playerPos =
    Number.isFinite(Number(issue.playerPosition)) && Number(issue.playerPosition) > 0
      ? Number(issue.playerPosition)
      : null;
  return (
    playerPos !== null &&
    defenderPosition !== null &&
    Number.isFinite(Number(defenderPosition)) &&
    Number(defenderPosition) > 0 &&
    playerPos === Number(defenderPosition)
  );
}

function hasStrictWindowBreachContext(issue: WarComplianceIssue): boolean {
  const breach = issue.breachContext;
  if (!breach) return false;
  const starsAtBreach = Number(breach.starsAtBreach);
  const timeRemaining = normalizeFwaPoliceText(breach.timeRemaining ?? "");
  return Number.isFinite(starsAtBreach) && starsAtBreach >= 0 && timeRemaining.length > 0;
}

/** Purpose: map one canonical compliance issue to the single supported police violation enum used by template resolution. */
export function classifyFwaPoliceViolationForEnforcement(input: {
  issue: WarComplianceIssue;
  context: FwaPoliceApplicabilityContext;
}): FwaPoliceEnforcementViolation | null {
  const exactFromLabel = classifyUsingCanonicalReasonLabel(
    input.issue.reasonLabel ?? "",
  );
  if (exactFromLabel) {
    if (
      exactFromLabel === "STRICT_WINDOW_MIRROR_MISS_WIN" &&
      !hasStrictWindowBreachContext(input.issue)
    ) {
      return null;
    }
    return isViolationApplicableToContext(exactFromLabel, input.context)
      ? exactFromLabel
      : null;
  }

  const fromLabel = classifyUsingReasonLabel(input.issue.reasonLabel ?? "");
  const hasStrictWindowContext = hasStrictWindowBreachContext(input.issue);
  if (fromLabel) {
    if (
      (fromLabel === "STRICT_WINDOW_MIRROR_MISS_WIN" ||
        fromLabel === "STRICT_WINDOW_MIRROR_MISS_LOSS") &&
      !hasStrictWindowContext
    ) {
      return null;
    }
    return isViolationApplicableToContext(fromLabel, input.context)
      ? fromLabel
      : null;
  }

  const details =
    input.issue.attackDetails?.filter((row) => row?.isBreach) ??
    input.issue.attackDetails ??
    [];
  const hasNonMirrorTriple = details.some(
    (row) =>
      !isMirrorAttack(input.issue, row.defenderPosition ?? null) &&
      Number(row.stars ?? 0) >= 3,
  );
  const hasNonMirrorTwoStar = details.some(
    (row) =>
      !isMirrorAttack(input.issue, row.defenderPosition ?? null) &&
      Number(row.stars ?? 0) === 2,
  );
  const hasAnyThreeStar = details.some((row) => Number(row.stars ?? 0) >= 3);

  if (input.context.matchType === "FWA" && input.context.expectedOutcome === "WIN") {
    if (hasNonMirrorTriple) return "EARLY_NON_MIRROR_TRIPLE";
    const violation = hasStrictWindowContext
      ? "STRICT_WINDOW_MIRROR_MISS_WIN"
      : null;
    return violation && isViolationApplicableToContext(violation, input.context)
      ? violation
      : null;
  }

  if (
    input.context.matchType === "FWA" &&
    input.context.expectedOutcome === "LOSE" &&
    input.context.loseStyle === "TRIPLE_TOP_30"
  ) {
    const hasLower20Attack = details.some(
      (row) => Number(row.defenderPosition ?? 0) > 30,
    );
    if (hasLower20Attack) return "LOWER20_ANY_STARS";
    const hasTop30ZeroStar = details.some(
      (row) =>
        Number.isFinite(Number(row.defenderPosition)) &&
        Number(row.defenderPosition) > 0 &&
        Number(row.defenderPosition) <= 30 &&
        Number(row.stars ?? 0) <= 0,
    );
    if (hasTop30ZeroStar) return "TOP30_ZERO_STARS";
    if (hasStrictWindowContext) {
      const violation = "STRICT_WINDOW_MIRROR_MISS_LOSS";
      return isViolationApplicableToContext(violation, input.context)
        ? violation
        : null;
    }
    return null;
  }

  if (
    input.context.matchType === "FWA" &&
    input.context.expectedOutcome === "LOSE" &&
    input.context.loseStyle === "TRADITIONAL"
  ) {
    if (hasAnyThreeStar) {
      const violation = "ANY_3STAR";
      return isViolationApplicableToContext(violation, input.context)
        ? violation
        : null;
    }
    if (hasNonMirrorTwoStar) {
      const violation = "EARLY_NON_MIRROR_2STAR";
      return isViolationApplicableToContext(violation, input.context)
        ? violation
        : null;
    }
    if (hasStrictWindowContext) {
      const violation = "STRICT_WINDOW_MIRROR_MISS_LOSS";
      return isViolationApplicableToContext(violation, input.context)
        ? violation
        : null;
    }
    return null;
  }

  return null;
}

/** Purpose: preserve the durable war-plan history contract; Police-only classifications remain generic there. */
export function classifyFwaPoliceViolation(input: {
  issue: WarComplianceIssue;
  context: FwaPoliceApplicabilityContext;
}): FwaPoliceViolation | null {
  const violation = classifyFwaPoliceViolationForEnforcement(input);
  if (
    violation === "TRADITIONAL_INVALID_CLEANUP_TARGET" ||
    violation === "TRADITIONAL_UNCLEARED_MIRROR"
  ) {
    return null;
  }
  return violation;
}
