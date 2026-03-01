/** Purpose: shared core types and pure helper logic for war event processing. */

export type WarState = "notInWar" | "preparation" | "inWar";
export type EventType = "war_started" | "battle_day" | "war_ended";
export type MatchType = "FWA" | "BL" | "MM" | null;
export type FwaLoseStyle = "TRIPLE_TOP_30" | "TRADITIONAL";

export type WarEndResultSnapshot = {
  clanStars: number | null;
  opponentStars: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
  warEndTime: Date | null;
  resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN";
};

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

/** Purpose: normalize a clan/player tag to uppercase with leading '#'. */
export function normalizeTag(input: string | null | undefined): string {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

/** Purpose: normalize a clan/player tag to uppercase without leading '#'. */
export function normalizeTagBare(input: string | null | undefined): string {
  return normalizeTag(input).replace(/^#/, "");
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
}): number | null {
  if (input.matchType === "BL") {
    if (input.finalResult.resultLabel === "WIN") return 3;
    if ((input.finalResult.clanDestruction ?? 0) >= 60) return 2;
    return 1;
  }
  if (
    input.before !== null &&
    Number.isFinite(input.before) &&
    input.after !== null &&
    Number.isFinite(input.after)
  ) {
    return input.after - input.before;
  }
  return null;
}

/** Purpose: compute missed/violating members for war-plan compliance checks. */
export function computeWarComplianceForTest(input: {
  clanTag: string;
  participants: WarComplianceParticipant[];
  attacks: WarComplianceAttack[];
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
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
  const attacks = [...input.attacks].sort((a, b) => {
    const t = a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
    if (t !== 0) return t;
    const o = (a.attackOrder ?? 0) - (b.attackOrder ?? 0);
    if (o !== 0) return o;
    return normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
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
    let cumulativeClanStars = 0;
    const starsBeforeAttack = new Map<number, number>();
    const starsAfterAttack = new Map<number, number>();
    for (let i = 0; i < attacks.length; i += 1) {
      const attack = attacks[i];
      const before = cumulativeClanStars;
      const gain = Math.max(0, Number(attack.trueStars ?? 0));
      cumulativeClanStars += gain;
      starsBeforeAttack.set(i, before);
      starsAfterAttack.set(i, cumulativeClanStars);
    }

    if (input.expectedOutcome === "WIN") {
      const mirrorTripleByPlayer = new Map<string, boolean>();
      const strictWindowSeenByPlayer = new Map<string, boolean>();
      for (let i = 0; i < attacks.length; i += 1) {
        const attack = attacks[i];
        const playerTag = normalizeTag(attack.playerTag);
        const playerPos = attack.playerPosition ?? null;
        const defenderPos = attack.defenderPosition ?? null;
        const stars = Number(attack.stars ?? 0);
        const trueStars = Number(attack.trueStars ?? 0);
        const hoursRemaining =
          attack.warEndTime instanceof Date
            ? (attack.warEndTime.getTime() - attack.attackSeenAt.getTime()) / (60 * 60 * 1000)
            : null;
        const isStrictWindow =
          hoursRemaining !== null &&
          Number.isFinite(hoursRemaining) &&
          hoursRemaining > 12 &&
          (starsBeforeAttack.get(i) ?? 0) < 100;
        if (isStrictWindow) {
          strictWindowSeenByPlayer.set(playerTag, true);
          const isMirror = playerPos !== null && defenderPos !== null && playerPos === defenderPos;
          if (isMirror && stars >= 3) {
            mirrorTripleByPlayer.set(playerTag, true);
          }
          if (!isMirror) {
            if (stars === 3 && trueStars > 0) addViolation(attack.playerTag, attack.playerName);
            if (stars <= 0) addViolation(attack.playerTag, attack.playerName);
          }
        }
      }
      for (const [playerTag, seenStrict] of strictWindowSeenByPlayer.entries()) {
        if (!seenStrict) continue;
        if (!mirrorTripleByPlayer.get(playerTag)) {
          addViolation(playerTag, labelForTag.get(playerTag) ?? playerTag);
        }
      }
    } else if (input.loseStyle === "TRIPLE_TOP_30") {
      for (const attack of attacks) {
        const defenderPos = attack.defenderPosition ?? null;
        if (defenderPos !== null && defenderPos > 30) {
          addViolation(attack.playerTag, attack.playerName);
        }
      }
    } else {
      for (let i = 0; i < attacks.length; i += 1) {
        const attack = attacks[i];
        const hoursRemaining =
          attack.warEndTime instanceof Date
            ? (attack.warEndTime.getTime() - attack.attackSeenAt.getTime()) / (60 * 60 * 1000)
            : null;
        const stars = Number(attack.stars ?? 0);
        if (hoursRemaining !== null && Number.isFinite(hoursRemaining) && hoursRemaining < 12) {
          const playerPos = attack.playerPosition ?? null;
          const defenderPos = attack.defenderPosition ?? null;
          const isMirror = playerPos !== null && defenderPos !== null && playerPos === defenderPos;
          const validLate = (isMirror && stars === 2) || (!isMirror && stars === 1);
          if (!validLate) addViolation(attack.playerTag, attack.playerName);
          continue;
        }
        if (!(stars === 1 || stars === 2)) addViolation(attack.playerTag, attack.playerName);
        if ((starsAfterAttack.get(i) ?? 0) > 100) addViolation(attack.playerTag, attack.playerName);
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

