import { prisma } from "../prisma";
import {
  listPlayerLinksForClanMembers,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  type FwaLoseStyle,
  type MatchType,
  type WarComplianceAttack,
  type WarComplianceWinGateConfig,
  type WarComplianceParticipant,
  type WarComplianceSnapshot,
  computeWarComplianceForTest,
  normalizeTagBare,
  normalizeOutcome,
  normalizeTag,
} from "./war-events/core";
import {
  DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
  resolveWarPlanComplianceConfig,
} from "./warPlanComplianceConfig";

export type WarComplianceIssue = {
  playerTag: string;
  playerName: string;
  playerPosition?: number | null;
  ruleType: "missed_both" | "not_following_plan";
  expectedBehavior: string;
  actualBehavior: string;
  attackDetails?: WarComplianceIssueAttackDetail[];
  breachContext?: WarComplianceBreachContext | null;
  reasonLabel?: string | null;
};

export type WarComplianceIssueAttackDetail = {
  defenderPosition: number | null;
  stars: number;
  attackOrder: number | null;
  isBreach: boolean;
};

export type WarComplianceBreachContext = {
  starsAtBreach: number;
  timeRemaining: string;
};

export type WarComplianceReport = {
  clanTag: string;
  clanName: string;
  opponentName: string | null;
  warId: number | null;
  warStartTime: Date;
  warEndTime: Date | null;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
  missedBoth: WarComplianceIssue[];
  notFollowingPlan: WarComplianceIssue[];
  participantsCount: number;
  attacksCount: number;
  fwaWinGateConfig: WarComplianceWinGateConfig | null;
};

export type WarComplianceCommandScope = "current" | "war_id";
export type WarComplianceDataSource = "war_attacks" | "war_lookup";
export type WarComplianceResolutionSource = "current_war" | "clan_war_history";
export type WarComplianceEvaluationStatus =
  | "ok"
  | "not_applicable"
  | "insufficient_data"
  | "no_active_war"
  | "war_not_found";

export type WarComplianceEvaluation = {
  status: WarComplianceEvaluationStatus;
  scope: WarComplianceCommandScope;
  source: WarComplianceDataSource | null;
  warResolutionSource: WarComplianceResolutionSource | null;
  clanTag: string;
  warId: number | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  clanName: string | null;
  opponentName: string | null;
  report: WarComplianceReport | null;
  participantsCount: number;
  attacksCount: number;
  timingInputs: {
    warEndTimeIso: string | null;
    firstAttackSeenAtIso: string | null;
    lastAttackSeenAtIso: string | null;
  };
};

type WarSeedRow = {
  warStartTime: Date;
  warId: number;
  warEndTime: Date | null;
};

type ComplianceContext = {
  guildId: string | null;
  useConfiguredFwaWinGate: boolean;
  clanTag: string;
  clanName: string;
  opponentName: string | null;
  warId: number | null;
  warStartTime: Date;
  warEndTime: Date | null;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  participants: WarComplianceParticipant[];
  attacks: WarComplianceAttack[];
  source: WarComplianceDataSource;
  warResolutionSource: WarComplianceResolutionSource;
};

type WarLookupMember = {
  tag: string;
  name: string | null;
  mapPosition: number | null;
};

type ParsedWarLookupPayload = {
  clanMembers: Map<string, WarLookupMember>;
  opponentMembers: Map<string, WarLookupMember>;
  attacks: Array<Record<string, unknown>>;
  payloadEndTime: Date | null;
  complianceCanonical: {
    participants: Array<Record<string, unknown>>;
    attacks: Array<Record<string, unknown>>;
    warEndTime: Date | null;
  } | null;
};

/** Purpose: produce a reusable clan-tag OR filter that supports stored with/without `#`. */
function buildClanTagWhere(tagInput: string): {
  OR: Array<{ clanTag: string }>;
} {
  const normalized = normalizeTag(tagInput);
  const bare = normalizeTagBare(tagInput);
  if (!bare) {
    return { OR: [{ clanTag: normalized }] };
  }
  if (normalized === bare) {
    return { OR: [{ clanTag: normalized }] };
  }
  return { OR: [{ clanTag: normalized }, { clanTag: bare }] };
}

/** Purpose: produce a reusable tracked-clan tag OR filter that supports stored with/without `#`. */
function buildTrackedClanTagWhere(tagInput: string): {
  OR: Array<{ tag: { equals: string; mode: "insensitive" } }>;
} {
  const normalized = normalizeTag(tagInput);
  const bare = normalizeTagBare(tagInput);
  const values = normalized === bare ? [normalized] : [normalized, bare];
  return {
    OR: values.map((value) => ({
      tag: { equals: value, mode: "insensitive" },
    })),
  };
}

/** Purpose: build a stable participant label from known name/tag fields. */
function getParticipantLabel(input: {
  playerName: string | null;
  playerTag: string;
}): string {
  const name = String(input.playerName ?? "").trim();
  return name || input.playerTag;
}

type AttackContext = {
  starsBeforeAttack: number;
  hoursRemaining: number | null;
  isStrictWindow: boolean;
  isMirror: boolean;
};

/** Purpose: ensure all compliance-side attack iteration uses the same deterministic chronology. */
function compareAttacksForComplianceOrder(
  a: WarComplianceAttack,
  b: WarComplianceAttack,
): number {
  const timeDelta = a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  const orderDelta = Number(a.attackOrder ?? 0) - Number(b.attackOrder ?? 0);
  if (orderDelta !== 0) return orderDelta;
  return normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
}

/** Purpose: sort attacks in the same chronology used by the shared compliance rule engine. */
function sortAttacksForComplianceOrder(
  attacks: WarComplianceAttack[],
): WarComplianceAttack[] {
  return [...attacks].sort(compareAttacksForComplianceOrder);
}

/** Purpose: choose attack-order chronology when all rows have usable attackOrder values; otherwise fall back deterministically. */
function sortAttacksForBreachContext(
  attacks: WarComplianceAttack[],
): WarComplianceAttack[] {
  const normalizedOrders = attacks.map((attack) =>
    normalizeAttackOrder(attack.attackOrder),
  );
  const allOrdersValid =
    normalizedOrders.length > 0 &&
    normalizedOrders.every((order) => order !== null && order > 0);
  if (!allOrdersValid) {
    return sortAttacksForComplianceOrder(attacks);
  }
  return [...attacks].sort((a, b) => {
    const orderDelta =
      Number(normalizeAttackOrder(a.attackOrder) ?? 0) -
      Number(normalizeAttackOrder(b.attackOrder) ?? 0);
    if (orderDelta !== 0) return orderDelta;
    return compareAttacksForComplianceOrder(a, b);
  });
}

/** Purpose: format numeric stars as the visual triplet required by compliance output. */
function formatStarTriplet(stars: number | null | undefined): string {
  const normalized = Math.max(0, Math.min(3, Number(stars ?? 0)));
  if (normalized >= 3) return "★ ★ ★";
  if (normalized >= 2) return "★ ★ ☆";
  if (normalized >= 1) return "★ ☆ ☆";
  return "☆ ☆ ☆";
}

/** Purpose: format strict-window timing as `Xh Ym left` for deterministic output. */
function formatTimeRemaining(hoursRemaining: number | null): string {
  if (hoursRemaining === null || !Number.isFinite(hoursRemaining))
    return "unknown left";
  const totalMinutes = Math.max(0, Math.floor(hoursRemaining * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m left`;
}

/** Purpose: derive stars-before-attack from lower attackOrder values when the breached row has a usable order. */
function computeStarsBeforeAttack(
  attack: WarComplianceAttack,
  allAttacks: WarComplianceAttack[],
  fallbackStarsBeforeAttack: number,
): number {
  const attackOrder = normalizeAttackOrder(attack.attackOrder);
  if (attackOrder === null || attackOrder <= 0) {
    return fallbackStarsBeforeAttack;
  }
  return allAttacks.reduce((total, row) => {
    const rowOrder = normalizeAttackOrder(row.attackOrder);
    if (rowOrder === null || rowOrder <= 0 || rowOrder >= attackOrder) {
      return total;
    }
    return total + Math.max(0, Number(row.trueStars ?? 0));
  }, 0);
}

/** Purpose: compute strict-window metadata once using the same ordering/rules as compliance checks. */
function buildAttackContextByAttack(
  attacks: WarComplianceAttack[],
  winGateConfig?: WarComplianceWinGateConfig | null,
): Map<WarComplianceAttack, AttackContext> {
  const ordered = sortAttacksForBreachContext(attacks);
  const minClanStarsBeforeNonMirrorTriple = Math.max(
    0,
    Math.trunc(Number(winGateConfig?.nonMirrorTripleMinClanStars ?? 100)),
  );
  const allBasesOpenHoursLeft = Math.max(
    0,
    Math.trunc(Number(winGateConfig?.allBasesOpenHoursLeft ?? 12)),
  );

  const result = new Map<WarComplianceAttack, AttackContext>();
  let cumulativeClanStars = 0;
  for (const attack of ordered) {
    const fallbackStarsBeforeAttack = cumulativeClanStars;
    const starsBeforeAttack = computeStarsBeforeAttack(
      attack,
      attacks,
      fallbackStarsBeforeAttack,
    );
    const gain = Math.max(0, Number(attack.trueStars ?? 0));
    cumulativeClanStars += gain;

    const hoursRemaining =
      attack.warEndTime instanceof Date
        ? (attack.warEndTime.getTime() - attack.attackSeenAt.getTime()) /
          (60 * 60 * 1000)
        : null;
    const starsGateActive =
      starsBeforeAttack < minClanStarsBeforeNonMirrorTriple;
    const isTimeGateActive =
      allBasesOpenHoursLeft <= 0
        ? true
        : hoursRemaining !== null &&
          Number.isFinite(hoursRemaining) &&
          hoursRemaining > allBasesOpenHoursLeft;
    const isStrictWindow = starsGateActive && isTimeGateActive;
    const playerPos = attack.playerPosition ?? null;
    const defenderPos = attack.defenderPosition ?? null;
    const isMirror =
      playerPos !== null && defenderPos !== null && playerPos === defenderPos;

    result.set(attack, {
      starsBeforeAttack,
      hoursRemaining,
      isStrictWindow,
      isMirror,
    });
  }
  return result;
}

type LinkedComplianceGroup = {
  key: string;
  isLinked: boolean;
  memberTags: string[];
  memberTagSet: Set<string>;
};

/** Purpose: track running clan true-stars totals in deterministic compliance order. */
function buildStarsAfterByAttackIndex(
  attacks: WarComplianceAttack[],
): Map<number, number> {
  const ordered = sortAttacksForComplianceOrder(attacks);
  const result = new Map<number, number>();
  let cumulative = 0;
  for (let idx = 0; idx < ordered.length; idx += 1) {
    const attack = ordered[idx];
    cumulative += Math.max(0, Number(attack.trueStars ?? 0));
    result.set(idx, cumulative);
  }
  return result;
}

/** Purpose: identify whether a traditional-loss attack row is in the late-window enforcement band. */
function isLateLoseTraditionalWindow(attack: WarComplianceAttack): boolean {
  if (!(attack.warEndTime instanceof Date)) return false;
  const hoursRemaining =
    (attack.warEndTime.getTime() - attack.attackSeenAt.getTime()) /
    (60 * 60 * 1000);
  return Number.isFinite(hoursRemaining) && hoursRemaining < 12;
}

type NotFollowingReason = {
  label: string;
  strictWindowContext: {
    starsBeforeAttack: number;
    timeRemaining: string;
  } | null;
  breachAttackOrders: number[];
};

type PlayerBehaviorDetails = {
  actualBehavior: string;
  reasonLabel: string;
  strictWindowContext: NotFollowingReason["strictWindowContext"];
  attackDetails: WarComplianceIssueAttackDetail[];
};

/** Purpose: normalize attack-order values so breach markers can be matched deterministically. */
function normalizeAttackOrder(value: number | null | undefined): number | null {
  const parsed = Number(value ?? NaN);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/** Purpose: append a normalized attack-order only once to keep breach markers stable. */
function pushUniqueAttackOrder(target: number[], value: number | null): void {
  if (value === null) return;
  if (target.includes(value)) return;
  target.push(value);
}

/** Purpose: compute a user-facing violation reason without changing compliance policy decisions. */
function describeNotFollowingReason(input: {
  playerAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): NotFollowingReason {
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") {
    const orderedPlayerAttacks = sortAttacksForBreachContext(
      input.playerAttacks,
    );
    let firstStrictContext: NotFollowingReason["strictWindowContext"] = null;
    let firstStrictWindowNonMirrorTripleContext: NotFollowingReason["strictWindowContext"] =
      null;
    let hasMirrorTripleInStrictWindow = false;
    const nonMirrorStrictTripleBreachOrders: number[] = [];
    const strictWindowNonCompliantOrders: number[] = [];

    for (const attack of orderedPlayerAttacks) {
      const ctx = input.attackContextByAttack.get(attack);
      if (!ctx?.isStrictWindow) continue;
      const strictContext = {
        starsBeforeAttack: ctx.starsBeforeAttack,
        timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
      };
      firstStrictContext = firstStrictContext ?? strictContext;
      const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);

      const stars = Number(attack.stars ?? 0);
      const trueStars = Number(attack.trueStars ?? 0);
      const isMirrorTriple = ctx.isMirror && stars >= 3;
      if (isMirrorTriple) {
        hasMirrorTripleInStrictWindow = true;
      } else {
        pushUniqueAttackOrder(strictWindowNonCompliantOrders, attackOrder);
      }
      if (!ctx.isMirror && stars === 3 && trueStars > 0) {
        firstStrictWindowNonMirrorTripleContext =
          firstStrictWindowNonMirrorTripleContext ?? strictContext;
        pushUniqueAttackOrder(nonMirrorStrictTripleBreachOrders, attackOrder);
      }
    }

    if (nonMirrorStrictTripleBreachOrders.length > 0) {
      return {
        label: "tripled non-mirror in strict window",
        strictWindowContext:
          firstStrictWindowNonMirrorTripleContext ?? firstStrictContext,
        breachAttackOrders: nonMirrorStrictTripleBreachOrders,
      };
    }

    if (firstStrictContext && !hasMirrorTripleInStrictWindow) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: firstStrictContext,
        breachAttackOrders: strictWindowNonCompliantOrders,
      };
    }

    return {
      label: "didn't follow win plan",
      strictWindowContext: firstStrictContext,
      breachAttackOrders: strictWindowNonCompliantOrders,
    };
  }

  if (input.matchType === "FWA" && input.expectedOutcome === "LOSE") {
    if (input.loseStyle === "TRIPLE_TOP_30") {
      return {
        label: "attacked outside top-30",
        strictWindowContext: null,
        breachAttackOrders: [],
      };
    }
    return {
      label: "didn't follow lose-style rules",
      strictWindowContext: null,
      breachAttackOrders: [],
    };
  }

  return {
    label: "hit non-mirror target",
    strictWindowContext: null,
    breachAttackOrders: [],
  };
}

/** Purpose: describe expected plan behavior for actionable compliance output lines. */
function describeExpectedPlanBehavior(input: {
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): string {
  if (input.matchType === "BL" || input.matchType === "MM") {
    return "War-plan compliance enforcement is disabled for BL/MM wars.";
  }
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") {
    return "Mirror triple in strict window; avoid off-mirror triples/zeros.";
  }
  if (input.matchType === "FWA" && input.expectedOutcome === "LOSE") {
    return input.loseStyle === "TRIPLE_TOP_30"
      ? "Lose style TRIPLE_TOP_30: attack top-30 bases only."
      : "Lose style TRADITIONAL: controlled 1-2 star flow and late-window constraints.";
  }
  return "Mirror-based fallback plan applies when expected outcome is unknown.";
}

/** Purpose: summarize observed attack behavior for one player in command output. */
function describeActualBehaviorForPlayer(input: {
  playerTag: string;
  attacksByPlayerTag: Map<string, WarComplianceAttack[]>;
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): PlayerBehaviorDetails {
  const normalizedTag = normalizeTag(input.playerTag);
  const playerAttacks = input.attacksByPlayerTag.get(normalizedTag) ?? [];
  if (playerAttacks.length === 0) {
    return {
      actualBehavior: "No attack rows recorded.",
      reasonLabel: "No details available.",
      strictWindowContext: null,
      attackDetails: [],
    };
  }
  const orderedAttacks = sortAttacksForComplianceOrder(playerAttacks);
  const attackSummaries = orderedAttacks.map(
    (row) =>
      `#${row.defenderPosition ?? "?"} (${formatStarTriplet(row.stars)})`,
  );
  const reason = describeNotFollowingReason({
    playerAttacks: orderedAttacks,
    attackContextByAttack: input.attackContextByAttack,
    matchType: input.matchType,
    expectedOutcome: input.expectedOutcome,
    loseStyle: input.loseStyle,
  });
  const breachOrders = new Set(reason.breachAttackOrders);
  const attackDetails = orderedAttacks.map((row) => ({
    defenderPosition: row.defenderPosition ?? null,
    stars: Math.max(0, Math.min(3, Number(row.stars ?? 0))),
    attackOrder: normalizeAttackOrder(row.attackOrder ?? null),
    isBreach: breachOrders.has(
      normalizeAttackOrder(row.attackOrder ?? null) ?? NaN,
    ),
  }));
  if (
    !attackDetails.some((detail) => detail.isBreach) &&
    attackDetails.length > 0
  ) {
    // Fail-safe: if source rows have missing attackOrder and no marker could be matched, mark the first line.
    attackDetails[0] = { ...attackDetails[0], isBreach: true };
  }
  const strictSuffix = reason.strictWindowContext
    ? ` | ${reason.strictWindowContext.starsBeforeAttack}★ | ${reason.strictWindowContext.timeRemaining}`
    : "";
  return {
    actualBehavior: `${attackSummaries.join(", ")} : ${reason.label}${strictSuffix}`,
    reasonLabel: reason.label,
    strictWindowContext: reason.strictWindowContext,
    attackDetails,
  };
}

/** Purpose: map rule-engine name output into detailed issues for user-facing command output. */
function mapNamesToIssues(input: {
  names: string[];
  ruleType: "missed_both" | "not_following_plan";
  expectedBehavior: string;
  participantByLabel: Map<string, WarComplianceParticipant>;
  attacksByPlayerTag: Map<string, WarComplianceAttack[]>;
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): WarComplianceIssue[] {
  return input.names.map((name) => {
    const participant = input.participantByLabel.get(name) ?? null;
    const playerTag = normalizeTag(participant?.playerTag ?? "") || "UNKNOWN";
    const behavior =
      input.ruleType === "missed_both"
        ? null
        : describeActualBehaviorForPlayer({
            playerTag,
            attacksByPlayerTag: input.attacksByPlayerTag,
            attackContextByAttack: input.attackContextByAttack,
            matchType: input.matchType,
            expectedOutcome: input.expectedOutcome,
            loseStyle: input.loseStyle,
          });
    return {
      playerTag,
      playerName: name,
      playerPosition: participant?.playerPosition ?? null,
      ruleType: input.ruleType,
      expectedBehavior: input.expectedBehavior,
      actualBehavior: behavior?.actualBehavior ?? "",
      attackDetails: behavior?.attackDetails ?? [],
      breachContext: behavior?.strictWindowContext
        ? {
            starsAtBreach: behavior.strictWindowContext.starsBeforeAttack,
            timeRemaining: behavior.strictWindowContext.timeRemaining,
          }
        : null,
      reasonLabel: behavior?.reasonLabel ?? null,
    };
  });
}

/** Purpose: build missed-both issues for non-FWA contexts so UI can show missed-attacks view. */
function buildMissedBothIssuesFromParticipants(
  participants: WarComplianceParticipant[],
): WarComplianceIssue[] {
  return participants
    .filter((row) => Number(row.attacksUsed ?? 0) <= 0)
    .map((row) => ({
      playerTag: normalizeTag(row.playerTag) || "UNKNOWN",
      playerName: getParticipantLabel({
        playerName: row.playerName,
        playerTag: row.playerTag,
      }),
      playerPosition: row.playerPosition ?? null,
      ruleType: "missed_both" as const,
      expectedBehavior: "Use both attacks for the war.",
      actualBehavior: "",
    }));
}

/** Purpose: normalize persisted match-type text to command-safe enum values. */
function normalizeMatchType(input: string | null | undefined): MatchType {
  const value = String(input ?? "")
    .trim()
    .toUpperCase();
  if (value === "FWA" || value === "BL" || value === "MM" || value === "SKIP") {
    return value;
  }
  return null;
}

/** Purpose: safely parse unknown values into finite integer numbers. */
function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

/** Purpose: safely parse unknown values into Date objects. */
function parseDateLike(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/** Purpose: narrow unknown values to object records. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Purpose: build a normalized member map from payload member arrays. */
function buildMemberMap(rawMembers: unknown): Map<string, WarLookupMember> {
  const result = new Map<string, WarLookupMember>();
  if (!Array.isArray(rawMembers)) return result;
  for (const raw of rawMembers) {
    const row = asRecord(raw);
    if (!row) continue;
    const tag = normalizeTag(String(row.tag ?? ""));
    if (!tag) continue;
    const nameRaw = String(row.name ?? "").trim();
    result.set(tag, {
      tag,
      name: nameRaw || null,
      mapPosition: toInt(row.mapPosition),
    });
  }
  return result;
}

/** Purpose: parse war lookup payload into normalized attack/member maps. */
function parseWarLookupPayload(payload: unknown): ParsedWarLookupPayload {
  let parsedPayload: unknown = payload;
  if (typeof parsedPayload === "string") {
    try {
      parsedPayload = JSON.parse(parsedPayload);
    } catch {
      parsedPayload = null;
    }
  }

  if (Array.isArray(parsedPayload)) {
    return {
      clanMembers: new Map(),
      opponentMembers: new Map(),
      attacks: parsedPayload.filter((row) => Boolean(asRecord(row))) as Array<
        Record<string, unknown>
      >,
      payloadEndTime: null,
      complianceCanonical: null,
    };
  }

  const root = asRecord(parsedPayload);
  if (!root) {
    return {
      clanMembers: new Map(),
      opponentMembers: new Map(),
      attacks: [],
      payloadEndTime: null,
      complianceCanonical: null,
    };
  }

  const warMeta = asRecord(root.warMeta);
  const clan = asRecord(root.clan);
  const opponent = asRecord(root.opponent);
  const compliance = asRecord(root.compliance);
  const complianceCanonical = asRecord(compliance?.canonical);
  const canonicalParticipants = Array.isArray(complianceCanonical?.participants)
    ? (complianceCanonical.participants.filter((row) =>
        Boolean(asRecord(row)),
      ) as Array<Record<string, unknown>>)
    : [];
  const canonicalAttacks = Array.isArray(complianceCanonical?.attacks)
    ? (complianceCanonical.attacks.filter((row) =>
        Boolean(asRecord(row)),
      ) as Array<Record<string, unknown>>)
    : [];
  const attackRows = Array.isArray(root.attacks)
    ? root.attacks.filter((row) => Boolean(asRecord(row)))
    : [];

  return {
    clanMembers: buildMemberMap(clan?.members),
    opponentMembers: buildMemberMap(opponent?.members),
    attacks: attackRows as Array<Record<string, unknown>>,
    payloadEndTime: parseDateLike(warMeta?.endTime ?? root.endTime ?? null),
    complianceCanonical:
      canonicalParticipants.length > 0 || canonicalAttacks.length > 0
        ? {
            participants: canonicalParticipants,
            attacks: canonicalAttacks,
            warEndTime: parseDateLike(
              complianceCanonical?.warEndTime ??
                complianceCanonical?.endTime ??
                compliance?.warEndTime ??
                null,
            ),
          }
        : null,
  };
}

/** Purpose: derive deterministic timing inputs for telemetry/debug output. */
function buildTimingInputs(input: {
  warEndTime: Date | null;
  attacks: WarComplianceAttack[];
}): WarComplianceEvaluation["timingInputs"] {
  const orderedAttackTimes = input.attacks
    .map((row) => row.attackSeenAt)
    .filter(
      (value): value is Date =>
        value instanceof Date && !Number.isNaN(value.getTime()),
    )
    .sort((a, b) => a.getTime() - b.getTime());
  return {
    warEndTimeIso:
      input.warEndTime instanceof Date ? input.warEndTime.toISOString() : null,
    firstAttackSeenAtIso:
      orderedAttackTimes.length > 0
        ? orderedAttackTimes[0].toISOString()
        : null,
    lastAttackSeenAtIso:
      orderedAttackTimes.length > 0
        ? orderedAttackTimes[orderedAttackTimes.length - 1].toISOString()
        : null,
  };
}

/** Purpose: identify incomplete contexts that should be reported as insufficient data. */
function hasInsufficientData(context: ComplianceContext): boolean {
  if (context.participants.length <= 0) return true;
  const anyAttacksUsed = context.participants.some(
    (row) => Number(row.attacksUsed ?? 0) > 0,
  );
  if (anyAttacksUsed && context.attacks.length <= 0) return true;
  return false;
}

/** Purpose: resolve lose-style configuration for a tracked clan with safe fallback. */
async function getLoseStyleForClan(
  clanTagInput: string,
): Promise<FwaLoseStyle> {
  const clanTag = normalizeTag(clanTagInput);
  if (!clanTag) return "TRIPLE_TOP_30";
  const row = await prisma.trackedClan.findFirst({
    where: buildTrackedClanTagWhere(clanTag),
    select: { loseStyle: true },
  });
  const loseStyle = String(row?.loseStyle ?? "").toUpperCase();
  if (loseStyle === "TRADITIONAL" || loseStyle === "TRIPLE_TOP_30") {
    return loseStyle;
  }
  return "TRIPLE_TOP_30";
}

/** Purpose: resolve ended-war seed row using explicit or latest war selection rules. */
async function getWarSeed(input: {
  clanTag: string;
  preferredWarStartTime?: Date | null;
  warId?: number | null;
}): Promise<WarSeedRow | null> {
  const clanTagWhere = buildClanTagWhere(input.clanTag);
  if (input.preferredWarStartTime instanceof Date) {
    const row = await prisma.warAttacks.findFirst({
      where: {
        ...clanTagWhere,
        warStartTime: input.preferredWarStartTime,
        warEndTime: { not: null },
        attackOrder: 0,
      },
      orderBy: [{ warStartTime: "desc" }],
      select: { warStartTime: true, warId: true, warEndTime: true },
    });
    if (!row) return null;
    return {
      warStartTime: row.warStartTime,
      warId: Number.isFinite(Number(row.warId))
        ? Math.trunc(Number(row.warId))
        : 0,
      warEndTime: row.warEndTime ?? null,
    };
  }
  if (
    input.warId !== null &&
    input.warId !== undefined &&
    Number.isFinite(input.warId)
  ) {
    const row = await prisma.warAttacks.findFirst({
      where: {
        ...clanTagWhere,
        warId: Math.trunc(input.warId),
        warEndTime: { not: null },
        attackOrder: 0,
      },
      orderBy: [{ warStartTime: "desc" }],
      select: { warStartTime: true, warId: true, warEndTime: true },
    });
    if (!row) return null;
    return {
      warStartTime: row.warStartTime,
      warId: Number.isFinite(Number(row.warId))
        ? Math.trunc(Number(row.warId))
        : 0,
      warEndTime: row.warEndTime ?? null,
    };
  }
  const row = await prisma.warAttacks.findFirst({
    where: {
      ...clanTagWhere,
      warEndTime: { not: null },
      attackOrder: 0,
    },
    orderBy: [{ warStartTime: "desc" }],
    select: { warStartTime: true, warId: true, warEndTime: true },
  });
  if (!row) return null;
  return {
    warStartTime: row.warStartTime,
    warId: Number.isFinite(Number(row.warId))
      ? Math.trunc(Number(row.warId))
      : 0,
    warEndTime: row.warEndTime ?? null,
  };
}

/** Purpose: centralize DB-backed compliance evaluation shared by events and user commands. */
export class WarComplianceService {
  /** Purpose: resolve compliance snapshot names for a clan+war context without extra command logic. */
  async getComplianceSnapshot(input: {
    clanTag: string;
    preferredWarStartTime?: Date | null;
    warId?: number | null;
    matchType: MatchType;
    expectedOutcome: "WIN" | "LOSE" | null;
  }): Promise<WarComplianceSnapshot> {
    const report = await this.getComplianceReport(input);
    if (!report) return { missedBoth: [], notFollowingPlan: [] };
    return {
      missedBoth: report.missedBoth.map((row) => row.playerName),
      notFollowingPlan: report.notFollowingPlan.map((row) => row.playerName),
    };
  }

  /** Purpose: evaluate compliance from command-driven war scope selection with deterministic result states. */
  async evaluateComplianceForCommand(input: {
    guildId: string;
    clanTag: string;
    scope: WarComplianceCommandScope;
    warId: number;
  }): Promise<WarComplianceEvaluation> {
    const startedAtMs = Date.now();
    const scope: WarComplianceCommandScope = input.scope;
    const clanTag = normalizeTag(input.clanTag);

    const buildResult = (params: {
      status: WarComplianceEvaluationStatus;
      source?: WarComplianceDataSource | null;
      warResolutionSource?: WarComplianceResolutionSource | null;
      warId?: number | null;
      warStartTime?: Date | null;
      warEndTime?: Date | null;
      matchType?: MatchType;
      expectedOutcome?: "WIN" | "LOSE" | null;
      clanName?: string | null;
      opponentName?: string | null;
      report?: WarComplianceReport | null;
      participantsCount?: number;
      attacksCount?: number;
      timingInputs?: WarComplianceEvaluation["timingInputs"];
    }): WarComplianceEvaluation => {
      const result: WarComplianceEvaluation = {
        status: params.status,
        scope,
        source: params.source ?? null,
        warResolutionSource: params.warResolutionSource ?? null,
        clanTag,
        warId: params.warId ?? null,
        warStartTime: params.warStartTime ?? null,
        warEndTime: params.warEndTime ?? null,
        matchType: params.matchType ?? null,
        expectedOutcome: params.expectedOutcome ?? null,
        clanName: params.clanName ?? null,
        opponentName: params.opponentName ?? null,
        report: params.report ?? null,
        participantsCount: Number(params.participantsCount ?? 0),
        attacksCount: Number(params.attacksCount ?? 0),
        timingInputs: params.timingInputs ?? {
          warEndTimeIso: null,
          firstAttackSeenAtIso: null,
          lastAttackSeenAtIso: null,
        },
      };

      const durationMs = Date.now() - startedAtMs;
      const missedBoth = result.report?.missedBoth.length ?? 0;
      const notFollowing = result.report?.notFollowingPlan.length ?? 0;
      console.info(
        [
          `[fwa-compliance] event=evaluated`,
          `scope=${result.scope}`,
          `source=${result.source ?? "none"}`,
          `war_resolution_source=${result.warResolutionSource ?? "none"}`,
          `war_id=${result.warId ?? "unknown"}`,
          `status=${result.status}`,
          `participants=${result.participantsCount}`,
          `attacks=${result.attacksCount}`,
          `missed_both=${missedBoth}`,
          `not_following=${notFollowing}`,
          `war_end_time=${result.timingInputs.warEndTimeIso ?? "unknown"}`,
          `first_attack_seen_at=${result.timingInputs.firstAttackSeenAtIso ?? "unknown"}`,
          `last_attack_seen_at=${result.timingInputs.lastAttackSeenAtIso ?? "unknown"}`,
          `duration_ms=${durationMs}`,
        ].join(" "),
      );

      return result;
    };

    if (!normalizeTagBare(clanTag)) {
      return buildResult({ status: "insufficient_data" });
    }

    let context: ComplianceContext | null = null;
    if (scope === "war_id") {
      if (
        input.warId === null ||
        input.warId === undefined ||
        !Number.isFinite(Number(input.warId)) ||
        Math.trunc(Number(input.warId)) <= 0
      ) {
        return buildResult({
          status: "war_not_found",
          warResolutionSource: "clan_war_history",
        });
      }
      context = await this.loadHistoricalComplianceContext({
        guildId: input.guildId,
        clanTag,
        warId: Math.trunc(Number(input.warId)),
      });
      if (!context) {
        return buildResult({
          status: "war_not_found",
          source: "war_lookup",
          warResolutionSource: "clan_war_history",
          warId: Math.trunc(Number(input.warId)),
        });
      }
    } else {
      if (
        !Number.isFinite(Number(input.warId)) ||
        Math.trunc(Number(input.warId)) <= 0
      ) {
        return buildResult({
          status: "no_active_war",
          source: "war_attacks",
          warResolutionSource: "current_war",
        });
      }
      context = await this.loadCurrentComplianceContext({
        guildId: input.guildId,
        clanTag,
        warId: Math.trunc(Number(input.warId)),
      });
      if (!context) {
        return buildResult({
          status: "no_active_war",
          source: "war_attacks",
          warResolutionSource: "current_war",
          warId: Math.trunc(Number(input.warId)),
        });
      }
    }

    const timingInputs = buildTimingInputs({
      warEndTime: context.warEndTime,
      attacks: context.attacks,
    });

    if (context.matchType !== "FWA") {
      const loseStyle = await getLoseStyleForClan(context.clanTag);
      const report: WarComplianceReport = {
        clanTag: context.clanTag,
        clanName: context.clanName,
        opponentName: context.opponentName,
        warId: context.warId,
        warStartTime: context.warStartTime,
        warEndTime: context.warEndTime,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        loseStyle,
        missedBoth: buildMissedBothIssuesFromParticipants(context.participants),
        notFollowingPlan: [],
        participantsCount: context.participants.length,
        attacksCount: context.attacks.length,
        fwaWinGateConfig: null,
      };
      return buildResult({
        status: "not_applicable",
        source: context.source,
        warResolutionSource: context.warResolutionSource,
        warId: context.warId,
        warStartTime: context.warStartTime,
        warEndTime: context.warEndTime,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        clanName: context.clanName,
        opponentName: context.opponentName,
        report,
        participantsCount: context.participants.length,
        attacksCount: context.attacks.length,
        timingInputs,
      });
    }

    if (hasInsufficientData(context)) {
      return buildResult({
        status: "insufficient_data",
        source: context.source,
        warResolutionSource: context.warResolutionSource,
        warId: context.warId,
        warStartTime: context.warStartTime,
        warEndTime: context.warEndTime,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        participantsCount: context.participants.length,
        attacksCount: context.attacks.length,
        timingInputs,
      });
    }

    const report = await this.buildReportFromContext(context);
    if (!report) {
      return buildResult({
        status: "insufficient_data",
        source: context.source,
        warResolutionSource: context.warResolutionSource,
        warId: context.warId,
        warStartTime: context.warStartTime,
        warEndTime: context.warEndTime,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        participantsCount: context.participants.length,
        attacksCount: context.attacks.length,
        timingInputs,
      });
    }

    return buildResult({
      status: "ok",
      source: context.source,
      warResolutionSource: context.warResolutionSource,
      warId: context.warId,
      warStartTime: context.warStartTime,
      warEndTime: context.warEndTime,
      matchType: context.matchType,
      expectedOutcome: context.expectedOutcome,
      participantsCount: context.participants.length,
      attacksCount: context.attacks.length,
      report,
      timingInputs,
    });
  }

  /** Purpose: produce detailed compliance issues for leadership-facing command responses. */
  async getComplianceReport(input: {
    clanTag: string;
    preferredWarStartTime?: Date | null;
    warId?: number | null;
    matchType: MatchType;
    expectedOutcome: "WIN" | "LOSE" | null;
  }): Promise<WarComplianceReport | null> {
    const clanTag = normalizeTag(input.clanTag);
    if (!normalizeTagBare(clanTag)) return null;
    if (input.matchType === "BL" || input.matchType === "MM") {
      return null;
    }

    const warSeed = await getWarSeed({
      clanTag,
      preferredWarStartTime: input.preferredWarStartTime ?? null,
      warId: input.warId ?? null,
    });
    if (!warSeed) return null;
    const clanTagWhere = buildClanTagWhere(clanTag);
    const participants = await prisma.warAttacks.findMany({
      where: {
        ...clanTagWhere,
        warStartTime: warSeed.warStartTime,
        attackOrder: 0,
      },
      select: {
        playerName: true,
        playerTag: true,
        attacksUsed: true,
        playerPosition: true,
      },
      orderBy: [{ playerPosition: "asc" }, { playerName: "asc" }],
    });
    const attacks = await prisma.warAttacks.findMany({
      where: {
        ...clanTagWhere,
        warStartTime: warSeed.warStartTime,
        attackOrder: { gt: 0 },
      },
      select: {
        playerTag: true,
        playerName: true,
        playerPosition: true,
        defenderPosition: true,
        stars: true,
        trueStars: true,
        attackSeenAt: true,
        warEndTime: true,
        attackOrder: true,
      },
      orderBy: [
        { attackSeenAt: "asc" },
        { attackOrder: "asc" },
        { playerTag: "asc" },
      ],
    });

    const context: ComplianceContext = {
      guildId: null,
      useConfiguredFwaWinGate: false,
      clanTag,
      clanName: clanTag,
      opponentName: null,
      warId: Number.isFinite(Number(warSeed.warId))
        ? Math.trunc(Number(warSeed.warId))
        : null,
      warStartTime: warSeed.warStartTime,
      warEndTime: warSeed.warEndTime,
      matchType: normalizeMatchType(input.matchType),
      expectedOutcome: normalizeOutcome(input.expectedOutcome),
      participants: participants as WarComplianceParticipant[],
      attacks: attacks as WarComplianceAttack[],
      source: "war_attacks",
      warResolutionSource: "current_war",
    };

    if (hasInsufficientData(context)) return null;
    return this.buildReportFromContext(context);
  }

  /** Purpose: load command-targeted active-war context from CurrentWar + WarAttacks. */
  private async loadCurrentComplianceContext(input: {
    guildId: string;
    clanTag: string;
    warId: number;
  }): Promise<ComplianceContext | null> {
    const clanTagWhere = buildClanTagWhere(input.clanTag);
    const stateWhere = {
      OR: [
        //
        { state: { equals: "preparation", mode: "insensitive" as const } },
        { state: { equals: "inWar", mode: "insensitive" as const } },
      ],
    };
    const current = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        warId: input.warId,
        AND: [clanTagWhere, stateWhere],
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        warId: true,
        startTime: true,
        endTime: true,
        matchType: true,
        outcome: true,
        clanName: true,
        opponentName: true,
      },
    });
    if (!current) return null;

    const resolvedWarId =
      current.warId !== null &&
      current.warId !== undefined &&
      Number.isFinite(Number(current.warId))
        ? Math.trunc(Number(current.warId))
        : null;
    if (
      resolvedWarId === null ||
      resolvedWarId !== Math.trunc(Number(input.warId))
    ) {
      return null;
    }

    const warAttacksWhere: Record<string, unknown> = {
      ...clanTagWhere,
      warId: resolvedWarId,
    };

    const [participants, attacks] = await Promise.all([
      prisma.warAttacks.findMany({
        where: {
          ...(warAttacksWhere as any),
          attackOrder: 0,
        },
        select: {
          playerName: true,
          playerTag: true,
          attacksUsed: true,
          playerPosition: true,
          warStartTime: true,
        },
        orderBy: [{ playerPosition: "asc" }, { playerName: "asc" }],
      }),
      prisma.warAttacks.findMany({
        where: {
          ...(warAttacksWhere as any),
          attackOrder: { gt: 0 },
        },
        select: {
          playerTag: true,
          playerName: true,
          playerPosition: true,
          defenderPosition: true,
          stars: true,
          trueStars: true,
          attackSeenAt: true,
          warEndTime: true,
          attackOrder: true,
          warStartTime: true,
        },
        orderBy: [
          { attackSeenAt: "asc" },
          { attackOrder: "asc" },
          { playerTag: "asc" },
        ],
      }),
    ]);

    const warStartTime =
      (current.startTime instanceof Date ? current.startTime : null) ??
      participants[0]?.warStartTime ??
      attacks[0]?.warStartTime ??
      null;
    if (!(warStartTime instanceof Date)) return null;

    const warEndTime =
      (current.endTime instanceof Date ? current.endTime : null) ??
      attacks[0]?.warEndTime ??
      null;

    return {
      guildId: input.guildId,
      useConfiguredFwaWinGate: true,
      clanTag: normalizeTag(input.clanTag),
      clanName:
        String(current.clanName ?? normalizeTag(input.clanTag)).trim() ||
        normalizeTag(input.clanTag),
      opponentName: String(current.opponentName ?? "").trim() || null,
      warId: resolvedWarId,
      warStartTime,
      warEndTime,
      matchType: normalizeMatchType(current.matchType as string | null),
      expectedOutcome: normalizeOutcome(current.outcome),
      participants: participants as WarComplianceParticipant[],
      attacks: attacks as WarComplianceAttack[],
      source: "war_attacks",
      warResolutionSource: "current_war",
    };
  }

  /** Purpose: load ended-war command context from ClanWarHistory + WarLookup + ClanWarParticipation. */
  private async loadHistoricalComplianceContext(input: {
    guildId: string;
    clanTag: string;
    warId: number;
  }): Promise<ComplianceContext | null> {
    const clanTagWhere = buildClanTagWhere(input.clanTag);
    const historyRow = await prisma.clanWarHistory.findFirst({
      where: {
        ...clanTagWhere,
        warId: Math.trunc(input.warId),
      },
      select: {
        warId: true,
        warStartTime: true,
        warEndTime: true,
        matchType: true,
        expectedOutcome: true,
        actualOutcome: true,
        clanName: true,
        opponentName: true,
      },
    });
    if (!historyRow) return null;

    const [lookupRow, participationRows] = await Promise.all([
      prisma.warLookup.findUnique({
        where: { warId: String(historyRow.warId) },
        select: { payload: true, result: true, endTime: true },
      }),
      prisma.clanWarParticipation.findMany({
        where: {
          guildId: input.guildId,
          warId: String(historyRow.warId),
          ...clanTagWhere,
        },
        select: {
          playerTag: true,
          playerName: true,
          attacksUsed: true,
          firstAttackAt: true,
        },
        orderBy: [{ playerName: "asc" }],
      }),
    ]);

    const parsedLookup = parseWarLookupPayload(lookupRow?.payload ?? null);
    const firstAttackAtByPlayerTag = new Map<string, Date>();
    for (const row of participationRows) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag || !(row.firstAttackAt instanceof Date)) continue;
      firstAttackAtByPlayerTag.set(playerTag, row.firstAttackAt);
    }

    const warEndTime =
      (historyRow.warEndTime instanceof Date ? historyRow.warEndTime : null) ??
      parsedLookup.complianceCanonical?.warEndTime ??
      parsedLookup.payloadEndTime ??
      (lookupRow?.endTime instanceof Date ? lookupRow.endTime : null) ??
      null;

    const canonicalRows = this.tryMapComplianceCanonicalRows({
      canonical: parsedLookup.complianceCanonical,
      warStartTime: historyRow.warStartTime,
      warEndTime,
    });
    const attacks =
      canonicalRows?.attacks ??
      this.mapHistoricalAttacks({
        warStartTime: historyRow.warStartTime,
        warEndTime,
        attackRows: parsedLookup.attacks,
        clanMembersByTag: parsedLookup.clanMembers,
        opponentMembersByTag: parsedLookup.opponentMembers,
        firstAttackAtByPlayerTag,
      });

    const participants =
      canonicalRows?.participants ??
      this.mapHistoricalParticipants({
        participationRows,
        clanMembersByTag: parsedLookup.clanMembers,
        attacks,
      });

    return {
      guildId: input.guildId,
      useConfiguredFwaWinGate: true,
      clanTag: normalizeTag(input.clanTag),
      clanName:
        String(historyRow.clanName ?? normalizeTag(input.clanTag)).trim() ||
        normalizeTag(input.clanTag),
      opponentName: String(historyRow.opponentName ?? "").trim() || null,
      warId: Number.isFinite(Number(historyRow.warId))
        ? Math.trunc(Number(historyRow.warId))
        : null,
      warStartTime: historyRow.warStartTime,
      warEndTime,
      matchType: normalizeMatchType(historyRow.matchType as string | null),
      expectedOutcome:
        normalizeOutcome(historyRow.expectedOutcome) ??
        normalizeOutcome(historyRow.actualOutcome) ??
        normalizeOutcome(
          typeof lookupRow?.result === "string" ? lookupRow.result : null,
        ),
      participants,
      attacks,
      source: "war_lookup",
      warResolutionSource: "clan_war_history",
    };
  }

  /** Purpose: prefer canonical compliance projection rows when the payload declares complete parseable inputs. */
  private tryMapComplianceCanonicalRows(input: {
    canonical: {
      participants: Array<Record<string, unknown>>;
      attacks: Array<Record<string, unknown>>;
      warEndTime: Date | null;
    } | null;
    warStartTime: Date;
    warEndTime: Date | null;
  }): {
    participants: WarComplianceParticipant[];
    attacks: WarComplianceAttack[];
  } | null {
    if (!input.canonical) return null;
    const resolvedWarEndTime = input.canonical.warEndTime ?? input.warEndTime;
    const participants = this.tryMapComplianceCanonicalParticipants(
      input.canonical.participants,
    );
    const attacks = this.tryMapComplianceCanonicalAttacks({
      rows: input.canonical.attacks,
      warEndTime: resolvedWarEndTime,
    });
    if (!participants || !attacks) return null;
    if (!(resolvedWarEndTime instanceof Date)) return null;
    return { participants, attacks };
  }

  /** Purpose: parse canonical participant rows; return null when required fields are not fully parseable. */
  private tryMapComplianceCanonicalParticipants(
    rows: Array<Record<string, unknown>>,
  ): WarComplianceParticipant[] | null {
    if (!Array.isArray(rows) || rows.length <= 0) return null;
    const participants: WarComplianceParticipant[] = [];
    for (const row of rows) {
      const playerTag = normalizeTag(String(row.playerTag ?? row.tag ?? ""));
      const playerPosition = toInt(row.playerPosition ?? row.mapPosition);
      const attacksUsed = toInt(row.attacksUsed);
      if (!playerTag || playerPosition === null || attacksUsed === null) {
        return null;
      }
      const playerName =
        String(row.playerName ?? row.name ?? "").trim() || playerTag;
      participants.push({
        playerTag,
        playerName,
        playerPosition,
        attacksUsed: Math.max(0, attacksUsed),
      });
    }
    return participants.sort((a, b) => {
      const posA = Number.isFinite(Number(a.playerPosition))
        ? Number(a.playerPosition)
        : Number.MAX_SAFE_INTEGER;
      const posB = Number.isFinite(Number(b.playerPosition))
        ? Number(b.playerPosition)
        : Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return String(a.playerName ?? a.playerTag).localeCompare(
        String(b.playerName ?? b.playerTag),
      );
    });
  }

  /** Purpose: parse canonical attack rows; return null when required fields are not fully parseable. */
  private tryMapComplianceCanonicalAttacks(input: {
    rows: Array<Record<string, unknown>>;
    warEndTime: Date | null;
  }): WarComplianceAttack[] | null {
    if (!Array.isArray(input.rows)) return null;
    const attacks: WarComplianceAttack[] = [];
    for (const row of input.rows) {
      const playerTag = normalizeTag(
        String(row.playerTag ?? row.attackerTag ?? row.tag ?? ""),
      );
      const playerPosition = toInt(row.playerPosition ?? row.attackerPosition);
      const defenderPosition = toInt(row.defenderPosition);
      const stars = toInt(row.stars);
      const trueStars = toInt(row.trueStars);
      const attackOrder = toInt(row.attackOrder ?? row.order);
      const attackSeenAt = parseDateLike(
        row.attackSeenAt ?? row.attackedAt ?? row.attackTime,
      );
      if (
        !playerTag ||
        playerPosition === null ||
        defenderPosition === null ||
        stars === null ||
        trueStars === null ||
        attackOrder === null ||
        attackOrder <= 0 ||
        !(attackSeenAt instanceof Date)
      ) {
        return null;
      }
      const playerName =
        String(row.playerName ?? row.attackerName ?? "").trim() || playerTag;
      attacks.push({
        playerTag,
        playerName,
        playerPosition,
        defenderPosition,
        stars: Math.max(0, stars),
        trueStars: Math.max(0, trueStars),
        attackSeenAt,
        warEndTime: input.warEndTime,
        attackOrder,
      });
    }
    return attacks.sort((a, b) => {
      const attackOrderDelta =
        Number(a.attackOrder ?? 0) - Number(b.attackOrder ?? 0);
      if (attackOrderDelta !== 0) return attackOrderDelta;
      const seenDelta = a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
      if (seenDelta !== 0) return seenDelta;
      return normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
    });
  }

  /** Purpose: map historical lookup payload attacks into compliance attack rows. */
  private mapHistoricalAttacks(input: {
    warStartTime: Date;
    warEndTime: Date | null;
    attackRows: Array<Record<string, unknown>>;
    clanMembersByTag: Map<string, WarLookupMember>;
    opponentMembersByTag: Map<string, WarLookupMember>;
    firstAttackAtByPlayerTag: Map<string, Date>;
  }): WarComplianceAttack[] {
    const orderedRows = input.attackRows
      .map((row, idx) => ({
        row,
        idx,
        order: toInt(row.order) ?? toInt(row.attackOrder) ?? idx + 1,
      }))
      .sort((a, b) => a.order - b.order || a.idx - b.idx);

    const defenderBestStars = new Map<string, number>();
    const fallbackSeenAt = input.warEndTime ?? input.warStartTime;
    const attacks: WarComplianceAttack[] = [];

    for (const wrapped of orderedRows) {
      const row = wrapped.row;
      const attackerTag = normalizeTag(
        String(row.attackerTag ?? row.playerTag ?? ""),
      );
      if (!attackerTag) continue;
      const defenderTag = normalizeTag(String(row.defenderTag ?? ""));

      const stars = Math.max(0, toInt(row.stars) ?? 0);
      const explicitTrueStars = toInt(row.trueStars);
      const previousBest = defenderTag
        ? (defenderBestStars.get(defenderTag) ?? 0)
        : 0;
      const trueStars =
        explicitTrueStars !== null
          ? Math.max(0, explicitTrueStars)
          : Math.max(0, stars - previousBest);
      if (defenderTag) {
        defenderBestStars.set(defenderTag, Math.max(previousBest, stars));
      }

      const attackerMember = input.clanMembersByTag.get(attackerTag);
      const defenderMember = input.opponentMembersByTag.get(defenderTag);
      const playerName =
        String(row.attackerName ?? "").trim() ||
        String(attackerMember?.name ?? "").trim() ||
        attackerTag;
      const defenderPosition =
        toInt(row.defenderPosition) ?? defenderMember?.mapPosition ?? null;
      const playerPosition =
        toInt(row.attackerPosition) ?? attackerMember?.mapPosition ?? null;
      const attackSeenAt =
        parseDateLike(
          row.attackSeenAt ?? row.attackedAt ?? row.attackTime ?? row.seenAt,
        ) ??
        input.firstAttackAtByPlayerTag.get(attackerTag) ??
        fallbackSeenAt;

      attacks.push({
        playerTag: attackerTag,
        playerName,
        playerPosition,
        defenderPosition,
        stars,
        trueStars,
        attackSeenAt,
        warEndTime: input.warEndTime,
        attackOrder: wrapped.order,
      });
    }

    return attacks;
  }

  /** Purpose: map historical participation + payload members into compliance participant rows. */
  private mapHistoricalParticipants(input: {
    participationRows: Array<{
      playerTag: string;
      playerName: string | null;
      attacksUsed: number;
      firstAttackAt: Date | null;
    }>;
    clanMembersByTag: Map<string, WarLookupMember>;
    attacks: WarComplianceAttack[];
  }): WarComplianceParticipant[] {
    const attacksUsedByTag = new Map<string, number>();
    for (const attack of input.attacks) {
      const tag = normalizeTag(attack.playerTag);
      attacksUsedByTag.set(tag, (attacksUsedByTag.get(tag) ?? 0) + 1);
    }

    const byTag = new Map<string, WarComplianceParticipant>();
    for (const row of input.participationRows) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      const member = input.clanMembersByTag.get(playerTag);
      byTag.set(playerTag, {
        playerTag,
        playerName:
          String(row.playerName ?? "").trim() ||
          String(member?.name ?? "").trim() ||
          playerTag,
        attacksUsed: Number.isFinite(Number(row.attacksUsed))
          ? Math.max(0, Math.trunc(Number(row.attacksUsed)))
          : (attacksUsedByTag.get(playerTag) ?? 0),
        playerPosition: member?.mapPosition ?? null,
      });
    }

    if (byTag.size === 0) {
      for (const member of input.clanMembersByTag.values()) {
        byTag.set(member.tag, {
          playerTag: member.tag,
          playerName: member.name ?? member.tag,
          attacksUsed: attacksUsedByTag.get(member.tag) ?? 0,
          playerPosition: member.mapPosition,
        });
      }
    }

    for (const attack of input.attacks) {
      const playerTag = normalizeTag(attack.playerTag);
      if (!playerTag || byTag.has(playerTag)) continue;
      byTag.set(playerTag, {
        playerTag,
        playerName: String(attack.playerName ?? "").trim() || playerTag,
        attacksUsed: attacksUsedByTag.get(playerTag) ?? 1,
        playerPosition: attack.playerPosition ?? null,
      });
    }

    return [...byTag.values()].sort((a, b) => {
      const posA = Number.isFinite(Number(a.playerPosition))
        ? Number(a.playerPosition)
        : Number.MAX_SAFE_INTEGER;
      const posB = Number.isFinite(Number(b.playerPosition))
        ? Number(b.playerPosition)
        : Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return String(a.playerName ?? a.playerTag).localeCompare(
        String(b.playerName ?? b.playerTag),
      );
    });
  }

  /** Purpose: resolve linked participant groups from canonical PlayerLink ownership for mirror-obligation substitutions. */
  private async resolveLinkedComplianceGroups(
    participants: WarComplianceParticipant[],
  ): Promise<LinkedComplianceGroup[]> {
    const participantByTag = new Map<string, WarComplianceParticipant>();
    const orderedParticipantTags: string[] = [];
    for (const participant of participants) {
      const tag = normalizeTag(participant.playerTag);
      if (!tag || participantByTag.has(tag)) continue;
      participantByTag.set(tag, participant);
      orderedParticipantTags.push(tag);
    }

    const orderedLinkLookupTags = orderedParticipantTags
      .map((tag) => normalizePlayerTag(tag))
      .filter(Boolean);
    const lookupTagsUnique = [...new Set(orderedLinkLookupTags)];
    const linkedRows =
      lookupTagsUnique.length >= 2
        ? await listPlayerLinksForClanMembers({
            memberTagsInOrder: lookupTagsUnique,
          }).catch(() => [])
        : [];
    const linkedUserByPlayerTag = new Map<string, string>(
      linkedRows.map((row) => [normalizePlayerTag(row.playerTag), row.discordUserId]),
    );

    const groupByKey = new Map<
      string,
      { key: string; isLinked: boolean; memberTags: string[] }
    >();
    for (const tag of orderedParticipantTags) {
      const strictTag = normalizePlayerTag(tag);
      const linkedUserId = strictTag
        ? linkedUserByPlayerTag.get(strictTag) ?? null
        : null;
      const key = linkedUserId ? `user:${linkedUserId}` : `tag:${tag}`;
      const existing = groupByKey.get(key) ?? {
        key,
        isLinked: Boolean(linkedUserId),
        memberTags: [],
      };
      existing.memberTags.push(tag);
      groupByKey.set(key, existing);
    }

    const sortedPosition = (tag: string): number => {
      const pos = participantByTag.get(tag)?.playerPosition;
      return Number.isFinite(Number(pos)) && Number(pos) > 0
        ? Number(pos)
        : Number.MAX_SAFE_INTEGER;
    };

    return [...groupByKey.values()].map((group) => {
      const memberTags = [...new Set(group.memberTags)].sort((a, b) => {
        const posDelta = sortedPosition(a) - sortedPosition(b);
        if (posDelta !== 0) return posDelta;
        return a.localeCompare(b);
      });
      return {
        key: group.key,
        isLinked: group.isLinked,
        memberTags,
        memberTagSet: new Set(memberTags),
      };
    });
  }

  /** Purpose: evaluate grouped mirror obligations for FWA-WIN strict-window rules using linked-account substitution. */
  private evaluateFwaWinLinkedGroupViolations(input: {
    group: LinkedComplianceGroup;
    orderedAttacks: WarComplianceAttack[];
    attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
    participantByTag: Map<string, WarComplianceParticipant>;
  }): Set<string> {
    const strictAttackIndexes: number[] = [];
    const strictSeenByTag = new Set<string>();
    const mirrorTripleInStrictByTag = new Set<string>();
    for (let idx = 0; idx < input.orderedAttacks.length; idx += 1) {
      const attack = input.orderedAttacks[idx];
      const playerTag = normalizeTag(attack.playerTag);
      if (!input.group.memberTagSet.has(playerTag)) continue;
      const context = input.attackContextByAttack.get(attack);
      if (!context?.isStrictWindow) continue;
      strictAttackIndexes.push(idx);
      strictSeenByTag.add(playerTag);
      if (context.isMirror && Number(attack.stars ?? 0) >= 3) {
        mirrorTripleInStrictByTag.add(playerTag);
      }
    }

    const obligations = [...strictSeenByTag]
      .map((ownerTag) => ({
        ownerTag,
        ownerPosition: input.participantByTag.get(ownerTag)?.playerPosition ?? null,
      }))
      .filter(
        (row): row is { ownerTag: string; ownerPosition: number } =>
          Number.isFinite(Number(row.ownerPosition)) &&
          Number(row.ownerPosition) > 0,
      )
      .sort((a, b) => {
        if (a.ownerPosition !== b.ownerPosition) {
          return a.ownerPosition - b.ownerPosition;
        }
        return a.ownerTag.localeCompare(b.ownerTag);
      });

    const usedAttackIndexes = new Set<number>();
    const satisfiedOwnerTags = new Set<string>();
    for (const obligation of obligations) {
      for (const idx of strictAttackIndexes) {
        if (usedAttackIndexes.has(idx)) continue;
        const attack = input.orderedAttacks[idx];
        const defenderPosition = Number(attack.defenderPosition ?? NaN);
        if (!Number.isFinite(defenderPosition) || defenderPosition <= 0) continue;
        if (defenderPosition !== obligation.ownerPosition) continue;
        if (Number(attack.stars ?? 0) < 3) continue;
        usedAttackIndexes.add(idx);
        satisfiedOwnerTags.add(obligation.ownerTag);
        break;
      }
    }

    const violatingTags = new Set<string>();
    for (const obligation of obligations) {
      if (!satisfiedOwnerTags.has(obligation.ownerTag)) {
        violatingTags.add(obligation.ownerTag);
      }
    }

    for (const idx of strictAttackIndexes) {
      const attack = input.orderedAttacks[idx];
      const context = input.attackContextByAttack.get(attack);
      if (!context || context.isMirror) continue;
      const playerTag = normalizeTag(attack.playerTag);
      const stars = Number(attack.stars ?? 0);
      const trueStars = Number(attack.trueStars ?? 0);
      if (stars <= 0) {
        violatingTags.add(playerTag);
        continue;
      }
      if (stars === 3 && trueStars > 0 && !usedAttackIndexes.has(idx)) {
        violatingTags.add(playerTag);
      }
    }

    for (const playerTag of strictSeenByTag) {
      const ownerPosition = input.participantByTag.get(playerTag)?.playerPosition;
      const hasOwnedMirror =
        Number.isFinite(Number(ownerPosition)) && Number(ownerPosition) > 0;
      if (hasOwnedMirror) continue;
      if (!mirrorTripleInStrictByTag.has(playerTag)) {
        violatingTags.add(playerTag);
      }
    }

    return violatingTags;
  }

  /** Purpose: evaluate grouped mirror obligations for FWA-LOSS_TRADITIONAL late-window mirror rules. */
  private evaluateFwaLossTraditionalLinkedGroupViolations(input: {
    group: LinkedComplianceGroup;
    orderedAttacks: WarComplianceAttack[];
    starsAfterByAttackIndex: Map<number, number>;
    participantByTag: Map<string, WarComplianceParticipant>;
  }): Set<string> {
    const lateAttackIndexes: number[] = [];
    const lateSeenByTag = new Set<string>();
    for (let idx = 0; idx < input.orderedAttacks.length; idx += 1) {
      const attack = input.orderedAttacks[idx];
      const playerTag = normalizeTag(attack.playerTag);
      if (!input.group.memberTagSet.has(playerTag)) continue;
      if (!isLateLoseTraditionalWindow(attack)) continue;
      lateAttackIndexes.push(idx);
      lateSeenByTag.add(playerTag);
    }

    const obligations = [...lateSeenByTag]
      .map((ownerTag) => ({
        ownerTag,
        ownerPosition: input.participantByTag.get(ownerTag)?.playerPosition ?? null,
      }))
      .filter(
        (row): row is { ownerTag: string; ownerPosition: number } =>
          Number.isFinite(Number(row.ownerPosition)) &&
          Number(row.ownerPosition) > 0,
      )
      .sort((a, b) => {
        if (a.ownerPosition !== b.ownerPosition) {
          return a.ownerPosition - b.ownerPosition;
        }
        return a.ownerTag.localeCompare(b.ownerTag);
      });

    const usedAttackIndexes = new Set<number>();
    const satisfiedOwnerTags = new Set<string>();
    for (const obligation of obligations) {
      for (const idx of lateAttackIndexes) {
        if (usedAttackIndexes.has(idx)) continue;
        const attack = input.orderedAttacks[idx];
        const defenderPosition = Number(attack.defenderPosition ?? NaN);
        if (!Number.isFinite(defenderPosition) || defenderPosition <= 0) continue;
        if (defenderPosition !== obligation.ownerPosition) continue;
        if (Number(attack.stars ?? 0) !== 2) continue;
        usedAttackIndexes.add(idx);
        satisfiedOwnerTags.add(obligation.ownerTag);
        break;
      }
    }

    const violatingTags = new Set<string>();
    for (let idx = 0; idx < input.orderedAttacks.length; idx += 1) {
      const attack = input.orderedAttacks[idx];
      const playerTag = normalizeTag(attack.playerTag);
      if (!input.group.memberTagSet.has(playerTag)) continue;
      const stars = Number(attack.stars ?? 0);

      if (isLateLoseTraditionalWindow(attack)) {
        const playerPosition = attack.playerPosition ?? null;
        const defenderPosition = attack.defenderPosition ?? null;
        const isMirror =
          playerPosition !== null &&
          defenderPosition !== null &&
          playerPosition === defenderPosition;
        const validLateAttack =
          (isMirror && stars === 2) ||
          (!isMirror && stars === 1) ||
          (stars === 2 && usedAttackIndexes.has(idx));
        if (!validLateAttack) {
          violatingTags.add(playerTag);
        }
        continue;
      }

      if (!(stars === 1 || stars === 2)) {
        violatingTags.add(playerTag);
      }
      if ((input.starsAfterByAttackIndex.get(idx) ?? 0) > 100) {
        violatingTags.add(playerTag);
      }
    }

    for (const obligation of obligations) {
      if (!satisfiedOwnerTags.has(obligation.ownerTag)) {
        violatingTags.add(obligation.ownerTag);
      }
    }

    return violatingTags;
  }

  /** Purpose: apply linked-account mirror-obligation substitutions to canonical not-following output without introducing police-only logic. */
  private async applyLinkedMirrorGroupingToNotFollowingNames(input: {
    baselineNames: string[];
    participantByLabel: Map<string, WarComplianceParticipant>;
    participants: WarComplianceParticipant[];
    attacks: WarComplianceAttack[];
    attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
    matchType: MatchType;
    expectedOutcome: "WIN" | "LOSE" | null;
    loseStyle: FwaLoseStyle;
  }): Promise<string[]> {
    const baselineNamesUniqueSorted = [...new Set(input.baselineNames)].sort((a, b) =>
      a.localeCompare(b),
    );
    const groupedModeEnabled =
      input.matchType === "FWA" &&
      (input.expectedOutcome === "WIN" ||
        (input.expectedOutcome === "LOSE" && input.loseStyle === "TRADITIONAL"));
    if (!groupedModeEnabled) return baselineNamesUniqueSorted;

    const groups = await this.resolveLinkedComplianceGroups(input.participants);
    const hasMultiLinkedGroup = groups.some(
      (group) => group.isLinked && group.memberTags.length > 1,
    );
    if (!hasMultiLinkedGroup) return baselineNamesUniqueSorted;

    const participantByTag = new Map<string, WarComplianceParticipant>();
    const labelByTag = new Map<string, string>();
    for (const participant of input.participants) {
      const tag = normalizeTag(participant.playerTag);
      if (!tag) continue;
      participantByTag.set(tag, participant);
      labelByTag.set(
        tag,
        getParticipantLabel({
          playerName: participant.playerName,
          playerTag: participant.playerTag,
        }),
      );
    }

    const preservedUnknownNames: string[] = [];
    const baselineViolationTags = new Set<string>();
    for (const name of baselineNamesUniqueSorted) {
      const participant = input.participantByLabel.get(name);
      const tag = normalizeTag(participant?.playerTag ?? "");
      if (!tag) {
        preservedUnknownNames.push(name);
        continue;
      }
      baselineViolationTags.add(tag);
    }

    const orderedAttacks = sortAttacksForComplianceOrder(input.attacks);
    const starsAfterByAttackIndex = buildStarsAfterByAttackIndex(input.attacks);
    for (const group of groups) {
      if (!group.isLinked || group.memberTags.length <= 1) continue;
      for (const memberTag of group.memberTags) {
        baselineViolationTags.delete(memberTag);
      }

      const groupedViolations =
        input.expectedOutcome === "WIN"
          ? this.evaluateFwaWinLinkedGroupViolations({
              group,
              orderedAttacks,
              attackContextByAttack: input.attackContextByAttack,
              participantByTag,
            })
          : this.evaluateFwaLossTraditionalLinkedGroupViolations({
              group,
              orderedAttacks,
              starsAfterByAttackIndex,
              participantByTag,
            });
      for (const tag of groupedViolations) {
        baselineViolationTags.add(tag);
      }
    }

    const mappedNames = [...baselineViolationTags]
      .map((tag) => labelByTag.get(tag))
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => a.localeCompare(b));
    return [...new Set([...mappedNames, ...preservedUnknownNames])].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /** Purpose: resolve effective FWA-WIN strict-window gate config for command evaluations. */
  private async resolveEffectiveFwaWinGateConfig(
    context: ComplianceContext,
  ): Promise<WarComplianceWinGateConfig> {
    if (!context.useConfiguredFwaWinGate || !context.guildId) {
      return {
        nonMirrorTripleMinClanStars: 100,
        allBasesOpenHoursLeft: 12,
      };
    }

    const normalizedClanTag = normalizeTag(context.clanTag);
    const clanTagWithHash = normalizedClanTag || "";
    const clanTagBare = normalizedClanTag.replace(/^#/, "");

    try {
      const [customPlan, defaultPlan] = await Promise.all([
        prisma.clanWarPlan.findFirst({
          where: {
            guildId: context.guildId,
            scope: "CUSTOM",
            OR: [
              { clanTag: { equals: clanTagWithHash, mode: "insensitive" } },
              { clanTag: { equals: clanTagBare, mode: "insensitive" } },
            ],
            matchType: "FWA",
            outcome: "WIN",
            loseStyle: "ANY",
          },
          select: {
            nonMirrorTripleMinClanStars: true,
            allBasesOpenHoursLeft: true,
          },
        }),
        prisma.clanWarPlan.findFirst({
          where: {
            guildId: context.guildId,
            scope: "DEFAULT",
            clanTag: "",
            matchType: "FWA",
            outcome: "WIN",
            loseStyle: "ANY",
          },
          select: {
            nonMirrorTripleMinClanStars: true,
            allBasesOpenHoursLeft: true,
          },
        }),
      ]);

      const resolved = resolveWarPlanComplianceConfig({
        primary: customPlan,
        fallback: defaultPlan,
      });
      return {
        nonMirrorTripleMinClanStars: resolved.nonMirrorTripleMinClanStars,
        allBasesOpenHoursLeft: resolved.allBasesOpenHoursLeft,
      };
    } catch {
      return {
        nonMirrorTripleMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
        allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
      };
    }
  }

  /** Purpose: build a detailed compliance report from a source-agnostic context model. */
  private async buildReportFromContext(
    context: ComplianceContext,
  ): Promise<WarComplianceReport | null> {
    const loseStyle = await getLoseStyleForClan(context.clanTag);
    const fwaWinGateConfig =
      context.matchType === "FWA" && context.expectedOutcome === "WIN"
        ? await this.resolveEffectiveFwaWinGateConfig(context)
        : null;
    const snapshot = computeWarComplianceForTest({
      clanTag: context.clanTag,
      participants: context.participants,
      attacks: context.attacks,
      matchType: context.matchType,
      expectedOutcome: context.expectedOutcome,
      loseStyle,
      winGateConfig: fwaWinGateConfig,
    });

    const participantByLabel = new Map<string, WarComplianceParticipant>();
    const attacksByPlayerTag = new Map<string, WarComplianceAttack[]>();
    const attackContextByAttack = buildAttackContextByAttack(
      context.attacks,
      fwaWinGateConfig,
    );

    for (const participant of context.participants) {
      const label = getParticipantLabel({
        playerName: participant.playerName,
        playerTag: participant.playerTag,
      });
      participantByLabel.set(label, participant);
    }
    for (const attack of context.attacks) {
      const tag = normalizeTag(attack.playerTag);
      const rows = attacksByPlayerTag.get(tag) ?? [];
      rows.push(attack);
      attacksByPlayerTag.set(tag, rows);
    }

    const expectedPlanBehavior = describeExpectedPlanBehavior({
      matchType: context.matchType,
      expectedOutcome: context.expectedOutcome,
      loseStyle,
    });
    const adjustedNotFollowingNames =
      await this.applyLinkedMirrorGroupingToNotFollowingNames({
        baselineNames: snapshot.notFollowingPlan,
        participantByLabel,
        participants: context.participants,
        attacks: context.attacks,
        attackContextByAttack,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        loseStyle,
      });

    return {
      clanTag: context.clanTag,
      clanName: context.clanName,
      opponentName: context.opponentName,
      warId: context.warId,
      warStartTime: context.warStartTime,
      warEndTime: context.warEndTime,
      matchType: context.matchType,
      expectedOutcome: context.expectedOutcome,
      loseStyle,
      missedBoth: mapNamesToIssues({
        names: snapshot.missedBoth,
        ruleType: "missed_both",
        expectedBehavior: "Use both attacks for the war.",
        participantByLabel,
        attacksByPlayerTag,
        attackContextByAttack,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        loseStyle,
      }),
      notFollowingPlan: mapNamesToIssues({
        names: adjustedNotFollowingNames,
        ruleType: "not_following_plan",
        expectedBehavior: expectedPlanBehavior,
        participantByLabel,
        attacksByPlayerTag,
        attackContextByAttack,
        matchType: context.matchType,
        expectedOutcome: context.expectedOutcome,
        loseStyle,
      }),
      participantsCount: context.participants.length,
      attacksCount: context.attacks.length,
      fwaWinGateConfig: context.useConfiguredFwaWinGate
        ? fwaWinGateConfig
        : null,
    };
  }
}
