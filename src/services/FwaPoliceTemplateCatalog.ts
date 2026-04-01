import type { ApplicationCommandOptionChoiceData } from "discord.js";
import { type WarComplianceIssue } from "./WarComplianceService";
import { type FwaLoseStyle, type MatchType } from "./war-events/core";

export const FWA_POLICE_VIOLATIONS = [
  "EARLY_NON_MIRROR_TRIPLE",
  "STRICT_WINDOW_MIRROR_MISS_WIN",
  "STRICT_WINDOW_MIRROR_MISS_LOSS",
  "EARLY_NON_MIRROR_2STAR",
  "ANY_3STAR",
  "LOWER20_ANY_STARS",
] as const;

export type FwaPoliceViolation = (typeof FWA_POLICE_VIOLATIONS)[number];

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
  FwaPoliceViolation,
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
    label: "Early non-mirror 2-star before FFA window",
    builtInTemplate:
      "{offender} took an early non-mirror 2-star before the FFA window. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" && context.expectedOutcome === "WIN",
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
    label: "Any stars on lower 20 bases in triple-top-30 loss",
    builtInTemplate:
      "{offender} earned stars on a lower-20 base while in triple-top-30 loss mode. Linked user: {user}.",
    isApplicable: (context) =>
      context.matchType === "FWA" &&
      context.expectedOutcome === "LOSE" &&
      context.loseStyle === "TRIPLE_TOP_30",
  },
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

function classifyUsingReasonLabel(labelRaw: string): FwaPoliceViolation | null {
  const label = normalizeFwaPoliceText(labelRaw).toLowerCase();
  if (!label) return null;
  if (label.includes("outside top-30")) return "LOWER20_ANY_STARS";
  if (label.includes("tripled non-mirror")) return "EARLY_NON_MIRROR_TRIPLE";
  if (label.includes("didn't triple mirror")) return "STRICT_WINDOW_MIRROR_MISS_WIN";
  if (label.includes("lose-style")) return "STRICT_WINDOW_MIRROR_MISS_LOSS";
  return null;
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
export function classifyFwaPoliceViolation(input: {
  issue: WarComplianceIssue;
  context: FwaPoliceApplicabilityContext;
}): FwaPoliceViolation | null {
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
    return fromLabel;
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
    if (hasNonMirrorTwoStar) return "EARLY_NON_MIRROR_2STAR";
    return hasStrictWindowContext ? "STRICT_WINDOW_MIRROR_MISS_WIN" : null;
  }

  if (
    input.context.matchType === "FWA" &&
    input.context.expectedOutcome === "LOSE" &&
    input.context.loseStyle === "TRIPLE_TOP_30"
  ) {
    return "LOWER20_ANY_STARS";
  }

  if (
    input.context.matchType === "FWA" &&
    input.context.expectedOutcome === "LOSE" &&
    input.context.loseStyle === "TRADITIONAL"
  ) {
    if (hasAnyThreeStar) return "ANY_3STAR";
    return hasStrictWindowContext ? "STRICT_WINDOW_MIRROR_MISS_LOSS" : null;
  }

  return null;
}
