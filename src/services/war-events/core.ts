/** Purpose: shared core types and pure helper logic for war event processing. */
import {
  normalizeClashTagBareInput,
  normalizeClashTagInput,
} from "../../helper/clashTag";

export type WarState = "notInWar" | "preparation" | "inWar";
export type EventType = "war_started" | "battle_day" | "war_ended";
export type MatchType = "FWA" | "BL" | "MM" | "SKIP" | null;
export type FwaLoseStyle = "TRIPLE_TOP_30" | "TRADITIONAL";

export type WarEndResultSnapshot = {
  clanStars: number | null;
  opponentStars: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
  warEndTime: Date | null;
  resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN";
};

type ResolvedWarEndOutcome = "WIN" | "LOSE" | "TIE" | "UNKNOWN";

export type WarComplianceSnapshot = {
  missedBoth: string[];
  notFollowingPlan: string[];
};

export type WarComplianceParticipant = {
  playerName: string | null;
  playerTag: string;
  attacksUsed: number | null;
  playerPosition: number | null;
};

export type WarComplianceAttack = {
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
  defenderPosition: number | null;
  stars: number | null;
  trueStars: number | null;
  attackSeenAt: Date;
  warEndTime: Date | null;
  attackOrder: number;
};

export type WarComplianceWinGateConfig = {
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
};

type AttackContext = {
  starsBeforeAttack: number;
  hoursRemaining: number | null;
  isStrictWindow: boolean;
  isMirror: boolean;
};

export type WarComplianceReason = {
  label: string;
  strictWindowContext: {
    starsBeforeAttack: number;
    timeRemaining: string;
  } | null;
  breachAttackOrders: number[];
  hasViolation: boolean;
};

/** Purpose: normalize a clan/player tag to uppercase with leading '#'. */
export function normalizeTag(input: string | null | undefined): string {
  return normalizeClashTagInput(input);
}

/** Purpose: normalize a clan/player tag to uppercase without leading '#'. */
export function normalizeTagBare(input: string | null | undefined): string {
  return normalizeClashTagBareInput(input);
}

/** Purpose: map CoC war state text to internal state enum. */
export function deriveState(rawState: string | null | undefined): WarState {
  const state = String(rawState ?? "").toLowerCase();
  if (state.includes("preparation")) return "preparation";
  if (state.includes("inwar")) return "inWar";
  return "notInWar";
}

/** Purpose: map event type to user-facing event title. */
export function eventTitle(eventType: EventType): string {
  if (eventType === "war_started") return "War Started";
  if (eventType === "battle_day") return "Battle Day";
  return "War Ended";
}

/** Purpose: decide which event should fire for a state transition. */
export function shouldEmit(prev: WarState, next: WarState): EventType | null {
  if (prev === "notInWar" && next === "preparation") return "war_started";
  if ((prev === "preparation" || prev === "notInWar") && next === "inWar") return "battle_day";
  if ((prev === "inWar" || prev === "preparation") && next === "notInWar") return "war_ended";
  return null;
}

/** Purpose: compute sortable rank for a single clan-tag character in tiebreak order. */
export function rankChar(ch: string): number {
  const order = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const idx = order.indexOf(ch);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

/** Purpose: compare clan tags according to FWA tiebreak ordering. */
export function compareTagsForTiebreak(primaryTag: string, opponentTag: string): number {
  const a = normalizeTag(primaryTag);
  const b = normalizeTag(opponentTag);
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ra = rankChar(a[i] ?? "");
    const rb = rankChar(b[i] ?? "");
    if (ra === rb) continue;
    return ra - rb;
  }
  return 0;
}

/** Purpose: derive expected WIN/LOSE outcome from points and sync tiebreak rules. */
export function deriveExpectedOutcome(
  clanTag: string,
  opponentTag: string,
  clanPoints: number | null,
  opponentPoints: number | null,
  syncNumber: number | null
): "WIN" | "LOSE" | null {
  if (clanPoints === null || opponentPoints === null) return null;
  if (clanPoints > opponentPoints) return "WIN";
  if (clanPoints < opponentPoints) return "LOSE";
  if (syncNumber === null) return null;
  const mode = syncNumber % 2 === 0 ? "high" : "low";
  const cmp = compareTagsForTiebreak(clanTag, opponentTag);
  if (cmp === 0) return null;
  const wins = mode === "low" ? cmp < 0 : cmp > 0;
  return wins ? "WIN" : "LOSE";
}

/** Purpose: parse CoC API timestamp string to Date. */
export function parseCocTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** Purpose: normalize expected outcome string to WIN/LOSE/null. */
export function normalizeOutcome(input: string | null | undefined): "WIN" | "LOSE" | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (normalized === "WIN" || normalized === "LOSE") return normalized;
  return null;
}

/** Purpose: trim/normalize clan display name values. */
export function sanitizeClanName(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return value ? value : null;
}

/** Purpose: format war destruction percentage for embeds. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return `${value.toFixed(2)}%`;
}

/** Purpose: format a member list for compact embed output. */
export function formatList(items: string[]): string {
  if (items.length === 0) return "None";
  const capped = items.slice(0, 15);
  const extra = items.length - capped.length;
  return extra > 0 ? `${capped.join(", ")} (+${extra} more)` : capped.join(", ");
}

/** Purpose: format a Date as Discord relative-time token. */
export function toDiscordRelativeTime(value: Date | null): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "unknown";
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

/** Purpose: compute war-end points delta according to match type rules. */
export function computeWarPointsDeltaForTest(input: {
  matchType: MatchType;
  before: number | null;
  after: number | null;
  finalResult: WarEndResultSnapshot;
  teamSize?: number | null;
}): number | null {
  const before = input.before !== null && Number.isFinite(input.before) ? input.before : null;
  if (before === null) return null;
  const expectedAfter = computeExpectedWarEndPointsForTest({
    matchType: input.matchType,
    before,
    finalResult: input.finalResult,
    outcome: null,
    teamSize: input.teamSize ?? null,
  });
  if (expectedAfter === null || !Number.isFinite(expectedAfter)) return null;
  return expectedAfter - before;
}

/** Purpose: compute expected post-war points using persisted before-points and match rules. */
export function computeExpectedWarEndPointsForTest(input: {
  matchType: MatchType;
  before: number | null;
  finalResult: WarEndResultSnapshot;
  outcome: "WIN" | "LOSE" | null;
  teamSize?: number | null;
}): number | null {
  const before = input.before !== null && Number.isFinite(input.before) ? Math.trunc(input.before) : null;
  if (before === null) return null;

  const resolvedOutcome = resolveWarEndOutcome(input.finalResult, input.outcome);
  if (resolvedOutcome === "UNKNOWN") return before;

  if (input.matchType === "MM") return before;
  if (input.matchType === "FWA") {
    if (resolvedOutcome === "WIN") return before - 1;
    if (resolvedOutcome === "LOSE") return before + 1;
    return before;
  }
  if (input.matchType === "BL") {
    const teamSize = Number.isFinite(Number(input.teamSize)) ? Math.trunc(Number(input.teamSize)) : null;
    const perfectWar =
      teamSize === 50
        ? Number(input.finalResult.clanStars ?? 0) === 150
        : teamSize === 45
          ? Number(input.finalResult.clanStars ?? 0) === 135
          : false;
    if (resolvedOutcome === "WIN" || perfectWar) return before + 3;
    if (Number(input.finalResult.clanDestruction ?? 0) > 60) return before + 2;
    return before + 1;
  }

  return before;
}

/** Purpose: resolve best-available war-end outcome from CoC result and stored expected outcome. */
function resolveWarEndOutcome(
  finalResult: WarEndResultSnapshot,
  outcome: "WIN" | "LOSE" | null
): ResolvedWarEndOutcome {
  if (finalResult.resultLabel === "WIN" || finalResult.resultLabel === "LOSE" || finalResult.resultLabel === "TIE") {
    return finalResult.resultLabel;
  }
  if (outcome === "WIN" || outcome === "LOSE") return outcome;
  return "UNKNOWN";
}

/** Purpose: sort attacks in the same deterministic chronology used by compliance checks. */
function sortAttacksForComplianceOrder(
  attacks: WarComplianceAttack[],
): WarComplianceAttack[] {
  return [...attacks].sort((a, b) => {
    const timeDelta = a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
    if (timeDelta !== 0) return timeDelta;
    const orderDelta = Number(a.attackOrder ?? 0) - Number(b.attackOrder ?? 0);
    if (orderDelta !== 0) return orderDelta;
    return normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
  });
}

/** Purpose: normalize attack-order values so breach markers stay deterministic. */
function normalizeAttackOrder(value: number | null | undefined): number | null {
  const parsed = Number(value ?? NaN);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/** Purpose: append one attack-order only once when collecting canonical breach orders. */
function pushUniqueAttackOrder(target: number[], value: number | null): void {
  if (value === null) return;
  if (target.includes(value)) return;
  target.push(value);
}

/** Purpose: format strict-window timing as a stable `Xh Ym left` string. */
function formatTimeRemaining(hoursRemaining: number | null): string {
  if (hoursRemaining === null || !Number.isFinite(hoursRemaining)) {
    return "unknown left";
  }
  const totalMinutes = Math.max(0, Math.floor(hoursRemaining * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m left`;
}

/** Purpose: build the shared strict-window metadata used by all compliance reasons. */
function buildAttackContextByAttack(
  attacks: WarComplianceAttack[],
  winGateConfig?: WarComplianceWinGateConfig | null,
): Map<WarComplianceAttack, AttackContext> {
  const ordered = sortAttacksForComplianceOrder(attacks);
  const minClanStarsBeforeNonMirrorTriple = Math.max(
    0,
    Math.trunc(Number(winGateConfig?.nonMirrorTripleMinClanStars ?? 101)),
  );
  const allBasesOpenHoursLeft = Math.max(
    0,
    Math.trunc(Number(winGateConfig?.allBasesOpenHoursLeft ?? 0)),
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

/** Purpose: derive stars-before-attack from lower attackOrder values when the row has a usable order. */
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
  }, fallbackStarsBeforeAttack);
}

/** Purpose: compute cumulative clan true-stars after each chronologically ordered attack. */
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

/** Purpose: classify one player's traditional-loss attacks using the shared canonical chronology. */
function classifyTraditionalLossReason(input: {
  playerAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  attackIndexByAttack: Map<WarComplianceAttack, number>;
  starsAfterByAttackIndex: Map<number, number>;
}): WarComplianceReason {
  const orderedPlayerAttacks = sortAttacksForComplianceOrder(input.playerAttacks);
  let playerAttackNumber = 0;

  for (const attack of orderedPlayerAttacks) {
    playerAttackNumber += 1;
    const ctx = input.attackContextByAttack.get(attack);
    const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);
    const stars = Math.max(0, Math.trunc(Number(attack.stars ?? 0)));
    const playerPos = attack.playerPosition ?? null;
    const defenderPos = attack.defenderPosition ?? null;
    const isMirror =
      playerPos !== null && defenderPos !== null && playerPos === defenderPos;
    const strictContext = ctx
      ? {
          starsBeforeAttack: ctx.starsBeforeAttack,
          timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
        }
      : null;
    const globalIndex = input.attackIndexByAttack.get(attack);
    const starsAfter =
      globalIndex !== null && globalIndex !== undefined
        ? input.starsAfterByAttackIndex.get(globalIndex) ?? null
        : null;

    if (
      ctx &&
      starsAfter !== null &&
      ctx.starsBeforeAttack <= 100 &&
      starsAfter > 100
    ) {
      return {
        label: "clan star cap exceeded",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }

    if (stars === 3) {
      return {
        label: "any 3-star in traditional loss",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }

    if (ctx?.isStrictWindow) {
      if (playerAttackNumber === 1) {
        if (!isMirror && stars === 2) {
          return {
            label: "early non-mirror 2-star in traditional loss",
            strictWindowContext: strictContext,
            breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
            hasViolation: true,
          };
        }
        if (isMirror && stars === 2) {
          continue;
        }
        return {
          label: "strict-window mirror miss in traditional loss",
          strictWindowContext: strictContext,
          breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
          hasViolation: true,
        };
      }

      if (playerAttackNumber === 2) {
        if (stars === 1) {
          continue;
        }
        return {
          label: "invalid star count in traditional loss",
          strictWindowContext: strictContext,
          breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
          hasViolation: true,
        };
      }

      if (stars === 2) {
        continue;
      }
      return {
        label: "invalid star count in traditional loss",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }

    if (stars === 2) {
      continue;
    }
    return {
      label: "invalid star count in traditional loss",
      strictWindowContext: strictContext,
      breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
      hasViolation: true,
    };
  }

  return {
    label: "didn't follow lose-style rules",
    strictWindowContext: null,
    breachAttackOrders: [],
    hasViolation: false,
  };
}

/** Purpose: classify one player's triple-top-30 attacks using the shared canonical chronology. */
function classifyTripleTop30Reason(input: {
  playerAttacks: WarComplianceAttack[];
  attackIndexByAttack: Map<WarComplianceAttack, number>;
  starsAfterByAttackIndex: Map<number, number>;
}): WarComplianceReason {
  const orderedPlayerAttacks = sortAttacksForComplianceOrder(input.playerAttacks);
  for (const attack of orderedPlayerAttacks) {
    const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);
    const globalIndex = input.attackIndexByAttack.get(attack);
    const defenderPos = attack.defenderPosition ?? null;
    const stars = Math.max(0, Math.trunc(Number(attack.stars ?? 0)));
    const starsAfter =
      globalIndex !== null && globalIndex !== undefined
        ? input.starsAfterByAttackIndex.get(globalIndex) ?? null
        : null;
    const starsBefore =
      globalIndex !== null
        ? starsAfter !== null
          ? starsAfter - Math.max(0, Number(attack.trueStars ?? 0))
          : null
        : null;
    const strictContext = starsBefore !== null
      ? {
          starsBeforeAttack: Math.max(0, Math.trunc(starsBefore)),
          timeRemaining:
            attack.warEndTime instanceof Date
              ? formatTimeRemaining(
                  (attack.warEndTime.getTime() - attack.attackSeenAt.getTime()) /
                    (60 * 60 * 1000),
                )
              : "unknown left",
        }
      : null;

    if (
      starsBefore !== null &&
      starsAfter !== null &&
      starsBefore <= 90 &&
      starsAfter > 90
    ) {
      return {
        label: "clan star cap exceeded",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }

    if (defenderPos !== null && defenderPos > 30) {
      return {
        label: "attack on a lower-20 base",
        strictWindowContext: null,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }

    if (defenderPos !== null && defenderPos > 0 && defenderPos <= 30 && stars <= 0) {
      return {
        label: "0-star attack on a top-30 base",
        strictWindowContext: null,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
  }

  return {
    label: "didn't follow lose-style rules",
    strictWindowContext: null,
    breachAttackOrders: [],
    hasViolation: false,
  };
}

/** Purpose: classify one player's FWA-WIN attacks using the shared canonical chronology. */
function classifyWinReason(input: {
  playerAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
}): WarComplianceReason {
  const orderedPlayerAttacks = sortAttacksForComplianceOrder(input.playerAttacks);
  let firstStrictWindowContext: WarComplianceReason["strictWindowContext"] = null;
  for (const attack of orderedPlayerAttacks) {
    const ctx = input.attackContextByAttack.get(attack);
    if (!ctx?.isStrictWindow) continue;
    const strictContext = {
      starsBeforeAttack: ctx.starsBeforeAttack,
      timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
    };
    firstStrictWindowContext = firstStrictWindowContext ?? strictContext;
    const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);
    const stars = Number(attack.stars ?? 0);
    const trueStars = Number(attack.trueStars ?? 0);
    if (!ctx.isMirror && stars === 3 && trueStars > 0) {
      return {
        label: "tripled non-mirror in strict window",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
    if (ctx.isMirror && stars < 3) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
    if (!ctx.isMirror && stars === 1) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
    if (!ctx.isMirror && stars <= 0) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
  }

  return {
    label: "didn't follow win plan",
    strictWindowContext: null,
    breachAttackOrders: [],
    hasViolation: false,
  };
}

/** Purpose: classify one player's plan compliance from deterministic chronological attack evidence. */
export function classifyComplianceReasonForPlayer(input: {
  playerAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  attackIndexByAttack: Map<WarComplianceAttack, number>;
  starsAfterByAttackIndex: Map<number, number>;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): WarComplianceReason {
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") {
    return classifyWinReason({
      playerAttacks: input.playerAttacks,
      attackContextByAttack: input.attackContextByAttack,
    });
  }

  if (input.matchType === "FWA" && input.expectedOutcome === "LOSE") {
    if (input.loseStyle === "TRIPLE_TOP_30") {
      return classifyTripleTop30Reason({
        playerAttacks: input.playerAttacks,
        attackIndexByAttack: input.attackIndexByAttack,
        starsAfterByAttackIndex: input.starsAfterByAttackIndex,
      });
    }
    return classifyTraditionalLossReason({
      playerAttacks: input.playerAttacks,
      attackContextByAttack: input.attackContextByAttack,
      attackIndexByAttack: input.attackIndexByAttack,
      starsAfterByAttackIndex: input.starsAfterByAttackIndex,
    });
  }

  return {
    label: "hit non-mirror target",
    strictWindowContext: null,
    breachAttackOrders: [],
    hasViolation: false,
  };
}

/** Purpose: compute missed/violating members for war-plan compliance checks. */
export function computeWarComplianceForTest(input: {
  clanTag: string;
  participants: WarComplianceParticipant[];
  attacks: WarComplianceAttack[];
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
  winGateConfig?: WarComplianceWinGateConfig | null;
}): WarComplianceSnapshot {
  if (input.matchType === "BL" || input.matchType === "MM") {
    return { missedBoth: [], notFollowingPlan: [] };
  }

  const participants = [...input.participants].sort((a, b) => {
    const posA = a.playerPosition ?? Number.MAX_SAFE_INTEGER;
    const posB = b.playerPosition ?? Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    return String(a.playerName ?? "").localeCompare(String(b.playerName ?? ""));
  });
  const attacks = sortAttacksForComplianceOrder(input.attacks);
  const attackContextByAttack = buildAttackContextByAttack(
    attacks,
    input.winGateConfig,
  );
  const attackIndexByAttack = new Map<WarComplianceAttack, number>();
  const starsAfterByAttackIndex = buildStarsAfterByAttackIndex(attacks);
  attacks.forEach((attack, index) => {
    attackIndexByAttack.set(attack, index);
  });

  const missedBoth = participants
    .filter((p) => Number(p.attacksUsed ?? 0) <= 0)
    .map((p) => String(p.playerName ?? p.playerTag).trim())
    .filter(Boolean);

  const labelForTag = new Map<string, string>();
  for (const p of participants) {
    const playerTag = normalizeTag(p.playerTag);
    const label = String(p.playerName ?? p.playerTag).trim();
    if (playerTag && label) labelForTag.set(playerTag, label);
  }
  const notFollowing = new Set<string>();
  const addViolation = (playerTagRaw: string | null | undefined, fallbackName: string | null | undefined) => {
    const playerTag = normalizeTag(playerTagRaw);
    const label = labelForTag.get(playerTag) ?? String(fallbackName ?? playerTagRaw ?? "").trim();
    if (label) notFollowing.add(label);
  };

  if (input.matchType === "FWA" && input.expectedOutcome) {
    if (input.expectedOutcome === "WIN") {
      for (const participant of participants) {
        const playerTag = normalizeTag(participant.playerTag);
        const playerAttacks = attacks.filter(
          (attack) => normalizeTag(attack.playerTag) === playerTag,
        );
        if (playerAttacks.length <= 0) continue;
        const reason = classifyComplianceReasonForPlayer({
          playerAttacks,
          attackContextByAttack,
          attackIndexByAttack,
          starsAfterByAttackIndex,
          matchType: input.matchType,
          expectedOutcome: input.expectedOutcome,
          loseStyle: input.loseStyle,
        });
        if (reason.hasViolation) {
          addViolation(playerTag, participant.playerName);
        }
      }
    } else if (input.loseStyle === "TRIPLE_TOP_30") {
      for (const participant of participants) {
        const playerTag = normalizeTag(participant.playerTag);
        const playerAttacks = attacks.filter(
          (attack) => normalizeTag(attack.playerTag) === playerTag,
        );
        if (playerAttacks.length <= 0) continue;
        const reason = classifyComplianceReasonForPlayer({
          playerAttacks,
          attackContextByAttack,
          attackIndexByAttack,
          starsAfterByAttackIndex,
          matchType: input.matchType,
          expectedOutcome: input.expectedOutcome,
          loseStyle: input.loseStyle,
        });
        if (reason.hasViolation) {
          addViolation(playerTag, participant.playerName);
        }
      }
    } else {
      for (const participant of participants) {
        const playerTag = normalizeTag(participant.playerTag);
        const playerAttacks = attacks.filter(
          (attack) => normalizeTag(attack.playerTag) === playerTag,
        );
        if (playerAttacks.length <= 0) continue;
        const reason = classifyComplianceReasonForPlayer({
          playerAttacks,
          attackContextByAttack,
          attackIndexByAttack,
          starsAfterByAttackIndex,
          matchType: input.matchType,
          expectedOutcome: input.expectedOutcome,
          loseStyle: input.loseStyle,
        });
        if (reason.hasViolation) {
          addViolation(playerTag, participant.playerName);
        }
      }
    }
  } else {
    for (const attack of attacks) {
      const playerPos = attack.playerPosition ?? null;
      const defenderPos = attack.defenderPosition ?? null;
      if (playerPos === null || defenderPos === null) continue;
      if (playerPos !== defenderPos) {
        addViolation(attack.playerTag, attack.playerName);
      }
    }
  }

  return {
    missedBoth,
    notFollowingPlan: [...notFollowing].sort((a, b) => a.localeCompare(b)),
  };
}

