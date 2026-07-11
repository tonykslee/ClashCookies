/** Purpose: shared core types and pure helper logic for war event processing. */
import {
  normalizeClashTagBareInput,
  normalizeClashTagInput,
} from "../../helper/clashTag";
import {
  DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
} from "../warPlanComplianceConfig";

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

const LEGACY_UNCONFIGURED_FWA_WIN_MIN_CLAN_STARS = 100;
const LEGACY_UNCONFIGURED_FWA_WIN_OPEN_HOURS_LEFT = 12;

export type WarComplianceLinkedGroup = {
  key: string;
  isLinked: boolean;
  memberTags: string[];
  memberTagSet: Set<string>;
};

export type AttackContext = {
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

export type TraditionalComplianceAttackDetail = {
  defenderPosition: number | null;
  stars: number;
  attackOrder: number | null;
  isBreach: boolean;
};

export type TraditionalViolationResult = {
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
  hasStrictParticipation: boolean;
  ownerSatisfied: boolean;
  hasViolation: boolean;
  reason: WarComplianceReason;
  attackDetails: TraditionalComplianceAttackDetail[];
  consumedSubstitutionAttackIndexes: number[];
  consumedSubstitutionAttackOrders: number[];
  actualBehavior: string;
};

export type TraditionalClanEvaluation = {
  resultsByPlayerTag: Map<string, TraditionalViolationResult>;
  satisfiedOwnerTags: Set<string>;
  consumedSubstitutionAttackIndexes: Set<number>;
  consumedSubstitutionAttackOrders: Set<number>;
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

/** Purpose: preserve the legacy WIN gate when no configured guild context is available. */
function resolveEffectiveGateConfigForCompliance(input: {
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
  winGateConfig?: WarComplianceWinGateConfig | null;
}): WarComplianceWinGateConfig | null {
  if (input.matchType !== "FWA" || input.expectedOutcome === null) {
    return input.winGateConfig ?? null;
  }
  if (input.expectedOutcome === "WIN") {
    return (
      input.winGateConfig ?? {
        nonMirrorTripleMinClanStars: LEGACY_UNCONFIGURED_FWA_WIN_MIN_CLAN_STARS,
        allBasesOpenHoursLeft: LEGACY_UNCONFIGURED_FWA_WIN_OPEN_HOURS_LEFT,
      }
    );
  }
  if (input.expectedOutcome === "LOSE" && input.loseStyle === "TRADITIONAL") {
    return (
      input.winGateConfig ?? {
        nonMirrorTripleMinClanStars:
          DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
        allBasesOpenHoursLeft:
          DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT,
      }
    );
  }
  if (input.expectedOutcome === "LOSE" && input.loseStyle === "TRIPLE_TOP_30") {
    return input.winGateConfig ?? null;
  }
  return input.winGateConfig ?? null;
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

/** Purpose: sort traditional-loss attacks by canonical obligation order without changing WIN chronology. */
function compareAttacksForTraditionalLossComplianceOrder(
  a: WarComplianceAttack,
  b: WarComplianceAttack,
): number {
  const orderA = normalizeAttackOrder(a.attackOrder ?? null);
  const orderB = normalizeAttackOrder(b.attackOrder ?? null);
  const hasOrderA = orderA !== null && orderA > 0;
  const hasOrderB = orderB !== null && orderB > 0;
  if (hasOrderA && hasOrderB) {
    const orderDelta = orderA - orderB;
    if (orderDelta !== 0) return orderDelta;
  } else if (hasOrderA !== hasOrderB) {
    return hasOrderA ? -1 : 1;
  }

  const timeDelta = a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
  if (timeDelta !== 0) return timeDelta;

  const tagDelta = normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
  if (tagDelta !== 0) return tagDelta;

  const defenderDelta = Number(a.defenderPosition ?? 0) - Number(b.defenderPosition ?? 0);
  if (defenderDelta !== 0) return defenderDelta;

  return Number(a.stars ?? 0) - Number(b.stars ?? 0);
}

/** Purpose: sort traditional-loss attacks using canonical positive-order precedence with time fallback. */
function sortAttacksForTraditionalLossComplianceOrder(
  attacks: WarComplianceAttack[],
): WarComplianceAttack[] {
  return [...attacks].sort(compareAttacksForTraditionalLossComplianceOrder);
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
export function buildAttackContextByAttack(
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

/** Purpose: collect defender positions that were actually tripled inside the strict window. */
function buildStrictWindowTripledPositions(
  allAttacks: WarComplianceAttack[],
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>,
): Set<number> {
  const result = new Set<number>();
  for (const attack of allAttacks) {
    const ctx = attackContextByAttack.get(attack);
    if (!ctx?.isStrictWindow) continue;
    if (Math.max(0, Number(attack.stars ?? 0)) < 3) continue;
    const defenderPosition = Math.trunc(Number(attack.defenderPosition ?? NaN));
    if (!Number.isFinite(defenderPosition) || defenderPosition <= 0) continue;
    result.add(defenderPosition);
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
  }, 0);
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

/** Purpose: evaluate FWA traditional-loss compliance across the whole clan with shared strict-phase state. */
export function evaluateFwaTraditionalLossComplianceForTest(input: {
  participants: WarComplianceParticipant[];
  attacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  linkedGroups?: WarComplianceLinkedGroup[] | null;
}): TraditionalClanEvaluation {
  const participants = [...input.participants].sort((a, b) => {
    const posA = a.playerPosition ?? Number.MAX_SAFE_INTEGER;
    const posB = b.playerPosition ?? Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    return String(a.playerName ?? "").localeCompare(String(b.playerName ?? ""));
  });
  const participantByTag = new Map<string, WarComplianceParticipant>();
  const ownerPositionByTag = new Map<string, number>();
  for (const participant of participants) {
    const tag = normalizeTag(participant.playerTag);
    if (!tag || participantByTag.has(tag)) continue;
    participantByTag.set(tag, participant);
    const playerPosition = Number(participant.playerPosition ?? NaN);
    if (Number.isFinite(playerPosition) && playerPosition > 0) {
      ownerPositionByTag.set(tag, Math.trunc(playerPosition));
    }
  }

  const orderedAttacks = sortAttacksForTraditionalLossComplianceOrder(input.attacks);
  const attackIndexByAttack = new Map<WarComplianceAttack, number>();
  orderedAttacks.forEach((attack, index) => {
    attackIndexByAttack.set(attack, index);
  });

  const linkedGroupKeyByTag = new Map<string, string>();
  for (const group of input.linkedGroups ?? []) {
    if (!group.isLinked || group.memberTags.length <= 1) continue;
    for (const memberTag of group.memberTags) {
      const normalizedTag = normalizeTag(memberTag);
      if (!normalizedTag) continue;
      linkedGroupKeyByTag.set(normalizedTag, group.key);
    }
  }

  const obligations = input.participants
    .map((participant) => {
      const tag = normalizeTag(participant.playerTag);
      const playerPosition = ownerPositionByTag.get(tag) ?? null;
      if (!tag || playerPosition === null) return null;
      const hasStrictAttack = orderedAttacks.some((attack) => {
        if (normalizeTag(attack.playerTag) !== tag) return false;
        const ctx = input.attackContextByAttack.get(attack);
        return Boolean(ctx?.isStrictWindow);
      });
      if (!hasStrictAttack) return null;
      return { ownerTag: tag, ownerPosition: playerPosition };
    })
    .filter(
      (row): row is { ownerTag: string; ownerPosition: number } => Boolean(row),
    )
    .sort((a, b) => {
      if (a.ownerPosition !== b.ownerPosition) return a.ownerPosition - b.ownerPosition;
      return a.ownerTag.localeCompare(b.ownerTag);
    });

  const satisfiedOwnerTags = new Set<string>();
  const consumedSubstitutionAttackIndexes = new Set<number>();
  const consumedSubstitutionAttackOrders = new Set<number>();
  for (const attack of orderedAttacks) {
    const ctx = input.attackContextByAttack.get(attack);
    if (!ctx?.isStrictWindow) continue;
    if (Math.max(0, Math.trunc(Number(attack.stars ?? 0))) !== 2) continue;
    const defenderPosition = Number(attack.defenderPosition ?? NaN);
    if (!Number.isFinite(defenderPosition) || defenderPosition <= 0) continue;
    const obligation = obligations.find(
      (row) =>
        row.ownerPosition === defenderPosition &&
        !satisfiedOwnerTags.has(row.ownerTag),
    );
    if (!obligation) continue;
    satisfiedOwnerTags.add(obligation.ownerTag);
    const attackTag = normalizeTag(attack.playerTag);
    const attackGroupKey = linkedGroupKeyByTag.get(attackTag) ?? null;
    const ownerGroupKey = linkedGroupKeyByTag.get(obligation.ownerTag) ?? null;
    if (
      attackGroupKey &&
      ownerGroupKey &&
      attackGroupKey === ownerGroupKey &&
      attackTag !== obligation.ownerTag
    ) {
      const attackIndex = attackIndexByAttack.get(attack);
      if (attackIndex !== undefined) {
        consumedSubstitutionAttackIndexes.add(attackIndex);
      }
      const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);
      if (attackOrder !== null) {
        consumedSubstitutionAttackOrders.add(attackOrder);
      }
    }
  }

  const resultsByPlayerTag = new Map<string, TraditionalViolationResult>();
  for (const participant of participants) {
    const playerTag = normalizeTag(participant.playerTag);
    if (!playerTag) continue;
    const playerAttacks = orderedAttacks.filter(
      (attack) => normalizeTag(attack.playerTag) === playerTag,
    );
    const playerAttacksOrdered = sortAttacksForTraditionalLossComplianceOrder(playerAttacks);
    const playerPosition = ownerPositionByTag.get(playerTag) ?? null;
    const ownSatisfied = satisfiedOwnerTags.has(playerTag);
    const attackDetails: TraditionalComplianceAttackDetail[] = [];
    const breachAttackOrders: number[] = [];
    let firstBreachContext: WarComplianceReason["strictWindowContext"] = null;
    let firstStrictContext: WarComplianceReason["strictWindowContext"] = null;
    let reasonLabel: string | null = null;
    let hasAttackLevelViolation = false;

    for (const attack of playerAttacksOrdered) {
      const ctx = input.attackContextByAttack.get(attack) ?? null;
      const attackOrder = normalizeAttackOrder(attack.attackOrder ?? null);
      const stars = Math.max(0, Math.trunc(Number(attack.stars ?? 0)));
      const trueStars = Math.max(0, Number(attack.trueStars ?? 0));
      const starsBefore = ctx?.starsBeforeAttack ?? null;
      const starsAfter =
        starsBefore !== null && Number.isFinite(starsBefore)
          ? starsBefore + trueStars
          : null;
      const isCapBreach =
        ctx !== null &&
        starsAfter !== null &&
        starsBefore !== null &&
        starsBefore <= 100 &&
        starsAfter > 100;
      const isStrict = Boolean(ctx?.isStrictWindow);
      if (isStrict && firstStrictContext === null) {
        firstStrictContext = ctx
          ? {
              starsBeforeAttack: ctx.starsBeforeAttack,
              timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
            }
          : null;
      }
      const attackIndex = attackIndexByAttack.get(attack);
      const defenderPosition = Number(attack.defenderPosition ?? NaN);
      const isOwnMirror =
        playerPosition !== null &&
        Number.isFinite(defenderPosition) &&
        defenderPosition === playerPosition;
      const isConsumedSubstitution =
        attackIndex !== undefined &&
        consumedSubstitutionAttackIndexes.has(attackIndex);
      let isBreach = false;

      if (isCapBreach) {
        isBreach = true;
        hasAttackLevelViolation = true;
        if (reasonLabel === null) {
          reasonLabel = "clan star cap exceeded";
          firstBreachContext = ctx
            ? {
                starsBeforeAttack: ctx.starsBeforeAttack,
                timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
              }
            : null;
        }
      } else if (isStrict) {
        if (stars === 3) {
          isBreach = true;
          hasAttackLevelViolation = true;
          if (reasonLabel === null) {
            reasonLabel = "any 3-star in traditional loss";
            firstBreachContext = ctx
              ? {
                  starsBeforeAttack: ctx.starsBeforeAttack,
                  timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
                }
              : null;
          }
        } else if (stars === 0) {
          isBreach = true;
          hasAttackLevelViolation = true;
          if (reasonLabel === null) {
            reasonLabel = "invalid star count in traditional loss";
            firstBreachContext = ctx
              ? {
                  starsBeforeAttack: ctx.starsBeforeAttack,
                  timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
                }
              : null;
          }
        } else if (stars === 2) {
          if (!isOwnMirror && !isConsumedSubstitution) {
            isBreach = true;
            hasAttackLevelViolation = true;
            if (reasonLabel === null) {
              reasonLabel = "early non-mirror 2-star in traditional loss";
              firstBreachContext = ctx
                ? {
                    starsBeforeAttack: ctx.starsBeforeAttack,
                    timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
                  }
                : null;
            }
          }
        } else if (stars === 1) {
          if (!ownSatisfied) {
            isBreach = true;
            hasAttackLevelViolation = true;
            if (reasonLabel === null) {
              reasonLabel = "strict-window mirror miss in traditional loss";
              firstBreachContext = ctx
                ? {
                    starsBeforeAttack: ctx.starsBeforeAttack,
                    timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
                  }
                : null;
            }
          }
        } else {
          isBreach = true;
          hasAttackLevelViolation = true;
          if (reasonLabel === null) {
            reasonLabel = "invalid star count in traditional loss";
            firstBreachContext = ctx
              ? {
                  starsBeforeAttack: ctx.starsBeforeAttack,
                  timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
                }
              : null;
          }
        }
      } else if (stars !== 2) {
        isBreach = true;
        hasAttackLevelViolation = true;
        if (reasonLabel === null) {
          reasonLabel = "invalid star count in traditional loss";
          firstBreachContext = ctx
            ? {
                starsBeforeAttack: ctx.starsBeforeAttack,
                timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
              }
            : null;
        }
      }

      if (isBreach && attackOrder !== null) {
        pushUniqueAttackOrder(breachAttackOrders, attackOrder);
      }

      attackDetails.push({
        defenderPosition: Number.isFinite(defenderPosition) ? defenderPosition : null,
        stars,
        attackOrder,
        isBreach,
      });
    }

    const hasStrictParticipation = playerAttacks.some((attack) =>
      Boolean(input.attackContextByAttack.get(attack)?.isStrictWindow),
    );
    const effectiveAttacksUsed = Math.max(
      playerAttacksOrdered.length,
      Math.max(0, Math.trunc(Number(participant.attacksUsed ?? 0))),
    );
    const hasUnmetMirrorViolation =
      hasStrictParticipation &&
      playerPosition !== null &&
      !ownSatisfied &&
      effectiveAttacksUsed >= 2 &&
      !hasAttackLevelViolation;
    const finalReason: WarComplianceReason = hasAttackLevelViolation || hasUnmetMirrorViolation
      ? {
          label:
            reasonLabel ??
            (hasUnmetMirrorViolation
              ? "strict-window mirror miss in traditional loss"
              : "didn't follow lose-style rules"),
          strictWindowContext: hasAttackLevelViolation
            ? firstBreachContext
            : hasUnmetMirrorViolation
              ? firstStrictContext
              : null,
          breachAttackOrders,
          hasViolation: true,
        }
      : {
          label: "didn't follow lose-style rules",
          strictWindowContext: null,
          breachAttackOrders: [],
          hasViolation: false,
        };
    const hasViolation = finalReason.hasViolation;

    const actualBehavior = `${playerAttacksOrdered
      .map((row) => `#${row.defenderPosition ?? "?"} (${Math.max(0, Math.trunc(Number(row.stars ?? 0)))})`)
      .join(", ")} : ${finalReason.label}${
      finalReason.strictWindowContext
        ? ` | ${finalReason.strictWindowContext.starsBeforeAttack}★ | ${finalReason.strictWindowContext.timeRemaining}`
        : ""
    }`;

    const playerConsumedSubstitutionAttackIndexes = playerAttacksOrdered
      .map((attack) => attackIndexByAttack.get(attack))
      .filter((attackIndex): attackIndex is number =>
        attackIndex !== undefined && consumedSubstitutionAttackIndexes.has(attackIndex),
      );
    const playerConsumedSubstitutionAttacks = playerAttacksOrdered.filter((attack) => {
      const attackIndex = attackIndexByAttack.get(attack);
      return attackIndex !== undefined && consumedSubstitutionAttackIndexes.has(attackIndex);
    });
    resultsByPlayerTag.set(playerTag, {
      playerTag,
      playerName: participant.playerName ?? null,
      playerPosition: participant.playerPosition ?? null,
      hasStrictParticipation,
      ownerSatisfied: ownSatisfied,
      hasViolation,
      reason: finalReason,
      attackDetails,
      consumedSubstitutionAttackIndexes: playerConsumedSubstitutionAttackIndexes,
      consumedSubstitutionAttackOrders: playerConsumedSubstitutionAttacks
        .map((attack) => normalizeAttackOrder(attack.attackOrder ?? null))
        .filter((value): value is number => value !== null),
      actualBehavior,
    });
  }

  return {
    resultsByPlayerTag,
    satisfiedOwnerTags,
    consumedSubstitutionAttackIndexes,
    consumedSubstitutionAttackOrders,
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
  allAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  playerAttacksUsed?: number | null;
}): WarComplianceReason {
  const orderedPlayerAttacks = sortAttacksForComplianceOrder(input.playerAttacks);
  const tripledPositions = buildStrictWindowTripledPositions(
    input.allAttacks,
    input.attackContextByAttack,
  );
  const playerPosition = orderedPlayerAttacks.find(
    (attack) => Number.isFinite(Number(attack.playerPosition ?? NaN)) && Number(attack.playerPosition ?? 0) > 0,
  )?.playerPosition ?? null;
  const effectiveAttacksUsed = Math.max(
    orderedPlayerAttacks.length,
    Math.max(0, Math.trunc(Number(input.playerAttacksUsed ?? 0))),
  );
  let firstStrictWindowContext: WarComplianceReason["strictWindowContext"] = null;
  let firstStrictAttackOrder: number | null = null;
  for (const attack of orderedPlayerAttacks) {
    const ctx = input.attackContextByAttack.get(attack);
    if (!ctx?.isStrictWindow) continue;
    const strictContext = {
      starsBeforeAttack: ctx.starsBeforeAttack,
      timeRemaining: formatTimeRemaining(ctx.hoursRemaining),
    };
    firstStrictWindowContext = firstStrictWindowContext ?? strictContext;
    firstStrictAttackOrder = firstStrictAttackOrder ?? normalizeAttackOrder(attack.attackOrder ?? null);
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
    if (!ctx.isMirror && stars <= 0) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: strictContext,
        breachAttackOrders: attackOrder !== null ? [attackOrder] : [],
        hasViolation: true,
      };
    }
  }

  if (
    playerPosition !== null &&
    !tripledPositions.has(Math.trunc(Number(playerPosition)))
  ) {
    if (effectiveAttacksUsed >= 2 && firstStrictWindowContext) {
      return {
        label: "didn't triple mirror",
        strictWindowContext: firstStrictWindowContext,
        breachAttackOrders: firstStrictAttackOrder !== null ? [firstStrictAttackOrder] : [],
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
  allAttacks: WarComplianceAttack[];
  attackContextByAttack: Map<WarComplianceAttack, AttackContext>;
  attackIndexByAttack: Map<WarComplianceAttack, number>;
  starsAfterByAttackIndex: Map<number, number>;
  playerAttacksUsed?: number | null;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): WarComplianceReason {
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") {
    return classifyWinReason({
      playerAttacks: input.playerAttacks,
      allAttacks: input.allAttacks,
      attackContextByAttack: input.attackContextByAttack,
      playerAttacksUsed: input.playerAttacksUsed,
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
  linkedGroups?: WarComplianceLinkedGroup[] | null;
}): WarComplianceSnapshot {
  if (input.matchType === "BL" || input.matchType === "MM") {
    return { missedBoth: [], notFollowingPlan: [] };
  }

  const effectiveWinGateConfig = resolveEffectiveGateConfigForCompliance({
    matchType: input.matchType,
    expectedOutcome: input.expectedOutcome,
    loseStyle: input.loseStyle,
    winGateConfig: input.winGateConfig,
  });

  const participants = [...input.participants].sort((a, b) => {
    const posA = a.playerPosition ?? Number.MAX_SAFE_INTEGER;
    const posB = b.playerPosition ?? Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    return String(a.playerName ?? "").localeCompare(String(b.playerName ?? ""));
  });
  const attacks = sortAttacksForComplianceOrder(input.attacks);
  const attackContextByAttack = buildAttackContextByAttack(
    attacks,
    effectiveWinGateConfig,
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
          allAttacks: attacks,
          attackContextByAttack,
          attackIndexByAttack,
          starsAfterByAttackIndex,
          playerAttacksUsed: participant.attacksUsed,
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
          allAttacks: attacks,
          attackContextByAttack,
          attackIndexByAttack,
          starsAfterByAttackIndex,
          playerAttacksUsed: participant.attacksUsed,
          matchType: input.matchType,
          expectedOutcome: input.expectedOutcome,
          loseStyle: input.loseStyle,
        });
        if (reason.hasViolation) {
          addViolation(playerTag, participant.playerName);
        }
      }
    } else {
      const traditionalEvaluation = evaluateFwaTraditionalLossComplianceForTest({
        participants,
        attacks,
        attackContextByAttack,
        linkedGroups: input.linkedGroups,
      });
      const orderedResults = [...traditionalEvaluation.resultsByPlayerTag.values()].sort(
        (a, b) => {
          const posA = a.playerPosition ?? Number.MAX_SAFE_INTEGER;
          const posB = b.playerPosition ?? Number.MAX_SAFE_INTEGER;
          if (posA !== posB) return posA - posB;
          return (a.playerTag ?? "").localeCompare(b.playerTag ?? "");
        },
      );
      return {
        missedBoth,
        notFollowingPlan: orderedResults
          .filter((result) => result.hasViolation)
          .map((result) => labelForTag.get(result.playerTag) ?? result.playerName ?? result.playerTag)
          .filter((label): label is string => Boolean(label)),
      };
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

