import {
  botLogChannelService,
  type BotLogChannelService,
  type RoutedBotLogRoutingConfig,
} from "./BotLogChannelService";
import { normalizeClashTagInput } from "../helper/clashTag";

/** Canonical, trigger-independent clan-goal identifiers. */
export const CLAN_GOAL_IDS = [
  "FWA_LOSE_TRADITIONAL_100_STARS",
  "FWA_LOSE_TOP30_90_CLEAN",
  "FWA_WIN_150_STARS",
  "FWA_NO_VIOLATIONS",
  "WAR_NO_MISSED_ATTACKS",
  "BL_150_STARS",
  "SYNC_ZERO_DEVIATION",
] as const;

export type ClanGoalId = (typeof CLAN_GOAL_IDS)[number];

export type ClanGoalEventIdentity = {
  guildId: string;
  clanTag: string;
  warId?: string | number | null;
  syncIdentity?: string | number | null;
};

export type ClanGoalDefinition = {
  id: ClanGoalId;
  label: string;
  snippets: readonly string[];
};

export type ClanGoalRoutingSource =
  | "clan_log"
  | "clan_lead"
  | "bot_log"
  | "custom";

export type ClanGoalDestination = {
  channelId: string;
  source: ClanGoalRoutingSource;
};

export type ClanGoalDestinationResolution =
  | ClanGoalDestination
  | {
      channelId: null;
      source: null;
      skipReason:
        | "disabled"
        | "missing_clan_log_channel"
        | "missing_clan_lead_channel"
        | "missing_bot_log_channel"
        | "missing_custom_channel";
    };

export type ClanGoalRenderedMessage = {
  content: string;
  allowedMentions: { parse: [] };
};

const CLAN_GOAL_CATALOG: readonly ClanGoalDefinition[] = [
  {
    id: "FWA_LOSE_TRADITIONAL_100_STARS",
    label: "FWA lose: traditional 100 stars",
    snippets: [
      "The stars were technically there. Morale was not.",
      "A traditional loss: handcrafted, artisanal, and mildly suspicious.",
      "We brought 100 stars and left the win at home.",
    ],
  },
  {
    id: "FWA_LOSE_TOP30_90_CLEAN",
    label: "FWA lose: top 30, 90 clean",
    snippets: [
      "Top 30 stayed clean. The result did not.",
      "90 stars. Bottom 20 untouched. The sacred scroll has been followed.",
      "The bases were tidy; the loss was aggressively untidy.",
    ],
  },
  {
    id: "FWA_WIN_150_STARS",
    label: "FWA win: 150 stars",
    snippets: [
      "150 stars acquired. Please clap in an orderly fashion.",
      "The star department would like everyone to remain calm.",
      "A three-digit star count has entered the chat.",
    ],
  },
  {
    id: "FWA_NO_VIOLATIONS",
    label: "FWA: no violations",
    snippets: [
      "No violations detected. Suspiciously well behaved.",
      "The rulebook remains untouched. A rare archaeological find.",
      "Clean war, clean conscience, probably clean spreadsheets too.",
    ],
  },
  {
    id: "WAR_NO_MISSED_ATTACKS",
    label: "War: no missed attacks",
    snippets: [
      "Nobody missed an attack. The alarm clock has been defeated.",
      "All attacks accounted for; the excuses are unemployed.",
      "Zero missed attacks. Even the bench is impressed.",
    ],
  },
  {
    id: "BL_150_STARS",
    label: "Blacklist: 150 stars",
    snippets: [
      "150 blacklist stars: villainy, but make it efficient.",
      "The blacklist has achieved triple digits and requests a tiny crown.",
      "150 stars of forbidden fun. Compliance is taking notes.",
    ],
  },
  {
    id: "SYNC_ZERO_DEVIATION",
    label: "Sync: zero deviation",
    snippets: [
      "Zero deviation. The numbers are behaving themselves today.",
      "A perfectly synced sync. Somebody frame this timestamp.",
      "No deviation detected; spreadsheets may now exhale.",
    ],
  },
];

const CLAN_GOAL_BY_ID = new Map(
  CLAN_GOAL_CATALOG.map((goal) => [goal.id, goal] as const),
);

export const LIVE_WAR_CLAN_GOAL_IDS = [
  "FWA_LOSE_TRADITIONAL_100_STARS",
  "FWA_LOSE_TOP30_90_CLEAN",
  "FWA_WIN_150_STARS",
  "BL_150_STARS",
] as const;

export type LiveWarClanGoalId = (typeof LIVE_WAR_CLAN_GOAL_IDS)[number];

export type LiveWarClanGoalFacts = {
  warState: "notInWar" | "preparation" | "inWar";
  matchType: "FWA" | "BL" | "MM" | "SKIP" | null;
  inferredMatchType: boolean | null | undefined;
  outcome: "WIN" | "LOSE" | "TIE" | "UNKNOWN" | string | null | undefined;
  loseStyle: "TRADITIONAL" | "TRIPLE_TOP_30" | string | null | undefined;
  clanStars: number | null | undefined;
  top30Clean?: boolean;
};

export type LiveWarClanGoalEvaluation = {
  goalId: LiveWarClanGoalId;
  qualified: boolean;
  reason:
    | "not_battle_day"
    | "classification_unsettled"
    | "match_type_mismatch"
    | "outcome_mismatch"
    | "lose_style_mismatch"
    | "stars_below_threshold"
    | "attack_cleanliness_not_checked"
    | "top30_attack_on_bottom_20"
    | "qualified";
  requiresAttackCleanliness?: boolean;
};

export type CanonicalWarEndGoalHistory = {
  warId: number | string;
  clanTag: string;
  matchType: string | null | undefined;
  expectedOutcome?: string | null | undefined;
  warEndTime: Date | string | null | undefined;
};

export type FwaNoViolationsGoalFacts = {
  guildId: string;
  warId: number | string;
  clanTag: string;
  history: CanonicalWarEndGoalHistory | null | undefined;
  evaluation:
    | {
        guildId: string;
        warId: number | string;
        status: string | null | undefined;
        matchType: string | null | undefined;
        expectedOutcome: string | null | undefined;
        violationCount: number | null | undefined;
      }
    | null
    | undefined;
};

export type WarNoMissedAttacksGoalFacts = {
  guildId: string;
  warId: number | string;
  clanTag: string;
  history: CanonicalWarEndGoalHistory | null | undefined;
  expectedParticipantCount: number | null | undefined;
  expectedParticipantCountAuthoritative: boolean;
  participation:
    | Array<{
        guildId: string;
        warId: number | string;
        clanTag: string;
        playerTag: string;
        attacksMissed: number | null | undefined;
      }>
    | null
    | undefined;
};

export type SyncZeroDeviationGoalFacts = {
  memberCount: number | null | undefined;
  projectionComplete: boolean;
  deviationScore: number | null | undefined;
};

export type SyncZeroDeviationGoalEvaluation = {
  goalId: "SYNC_ZERO_DEVIATION";
  qualified: boolean;
  reason:
    | "member_count_mismatch"
    | "projection_incomplete"
    | "deviation_unavailable"
    | "deviation_nonzero"
    | "qualified";
};

export type CanonicalWarEndGoalEvaluation = {
  goalId: "FWA_NO_VIOLATIONS" | "WAR_NO_MISSED_ATTACKS";
  qualified: boolean;
  reason:
    | "missing_history"
    | "history_not_ended"
    | "history_war_mismatch"
    | "history_clan_mismatch"
    | "history_match_type_mismatch"
    | "evaluation_canonical_mismatch"
    | "evaluation_missing"
    | "evaluation_identity_mismatch"
    | "evaluation_not_completed"
    | "violations_present"
    | "participation_missing"
    | "participant_count_missing"
    | "participant_count_mismatch"
    | "participant_identity_mismatch"
    | "participant_roster_incomplete"
    | "missed_attacks_present"
    | "qualified";
};

function sameWarId(left: number | string, right: number | string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    ? Math.trunc(leftNumber) === Math.trunc(rightNumber)
    : String(left).trim() === String(right).trim();
}

function normalizeCanonicalText(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function isEndedHistoryForGoal(input: {
  history: CanonicalWarEndGoalHistory | null | undefined;
  warId: number | string;
  clanTag: string;
}): CanonicalWarEndGoalEvaluation["reason"] | null {
  if (!input.history) return "missing_history";
  if (!input.history.warEndTime) return "history_not_ended";
  if (!sameWarId(input.history.warId, input.warId)) {
    return "history_war_mismatch";
  }
  if (normalizeClanTag(input.history.clanTag) !== normalizeClanTag(input.clanTag)) {
    return "history_clan_mismatch";
  }
  return null;
}

/** Purpose: evaluate FWA_NO_VIOLATIONS from canonical archived history and completed compliance. */
export function evaluateFwaNoViolationsGoal(
  input: FwaNoViolationsGoalFacts,
): CanonicalWarEndGoalEvaluation {
  const historyReason = isEndedHistoryForGoal(input);
  if (historyReason) {
    return { goalId: "FWA_NO_VIOLATIONS", qualified: false, reason: historyReason };
  }
  if (String(input.history?.matchType ?? "").toUpperCase() !== "FWA") {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "history_match_type_mismatch",
    };
  }
  if (!input.evaluation) {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "evaluation_missing",
    };
  }
  if (
    input.evaluation.guildId !== input.guildId ||
    !sameWarId(input.evaluation.warId, input.warId)
  ) {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "evaluation_identity_mismatch",
    };
  }
  if (String(input.evaluation.status ?? "").toUpperCase() !== "COMPLETED") {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "evaluation_not_completed",
    };
  }
  if (
    normalizeCanonicalText(input.evaluation.matchType) !==
      normalizeCanonicalText(input.history?.matchType) ||
    normalizeCanonicalText(input.evaluation.expectedOutcome) !==
      normalizeCanonicalText(input.history?.expectedOutcome)
  ) {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "evaluation_canonical_mismatch",
    };
  }
  if (
    input.evaluation.violationCount === null ||
    input.evaluation.violationCount === undefined ||
    !Number.isInteger(Number(input.evaluation.violationCount)) ||
    Number(input.evaluation.violationCount) !== 0
  ) {
    return {
      goalId: "FWA_NO_VIOLATIONS",
      qualified: false,
      reason: "violations_present",
    };
  }
  return { goalId: "FWA_NO_VIOLATIONS", qualified: true, reason: "qualified" };
}

/** Purpose: evaluate WAR_NO_MISSED_ATTACKS from a complete canonical roster snapshot. */
export function evaluateWarNoMissedAttacksGoal(
  input: WarNoMissedAttacksGoalFacts,
): CanonicalWarEndGoalEvaluation {
  const historyReason = isEndedHistoryForGoal(input);
  if (historyReason) {
    return { goalId: "WAR_NO_MISSED_ATTACKS", qualified: false, reason: historyReason };
  }
  const expectedCount = Number(input.expectedParticipantCount);
  if (input.expectedParticipantCountAuthoritative !== true) {
    return {
      goalId: "WAR_NO_MISSED_ATTACKS",
      qualified: false,
      reason: "participant_count_missing",
    };
  }
  if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
    return {
      goalId: "WAR_NO_MISSED_ATTACKS",
      qualified: false,
      reason: "participant_count_missing",
    };
  }
  if (!input.participation || input.participation.length === 0) {
    return {
      goalId: "WAR_NO_MISSED_ATTACKS",
      qualified: false,
      reason: "participation_missing",
    };
  }
  const participantTags = new Set<string>();
  for (const participant of input.participation) {
    if (
      participant.guildId !== input.guildId ||
      !sameWarId(participant.warId, input.warId) ||
      normalizeClanTag(participant.clanTag) !== normalizeClanTag(input.clanTag)
    ) {
      return {
        goalId: "WAR_NO_MISSED_ATTACKS",
        qualified: false,
        reason: "participant_identity_mismatch",
      };
    }
    const playerTag = normalizeClanTag(participant.playerTag);
    if (!playerTag || participantTags.has(playerTag)) {
      return {
        goalId: "WAR_NO_MISSED_ATTACKS",
        qualified: false,
        reason: "participant_roster_incomplete",
      };
    }
    participantTags.add(playerTag);
    if (
      participant.attacksMissed === null ||
      participant.attacksMissed === undefined ||
      !Number.isInteger(Number(participant.attacksMissed))
    ) {
      return {
        goalId: "WAR_NO_MISSED_ATTACKS",
        qualified: false,
        reason: "participant_roster_incomplete",
      };
    }
    if (Number(participant.attacksMissed) !== 0) {
      return {
        goalId: "WAR_NO_MISSED_ATTACKS",
        qualified: false,
        reason: "missed_attacks_present",
      };
    }
  }
  if (participantTags.size !== expectedCount || input.participation.length !== expectedCount) {
    return {
      goalId: "WAR_NO_MISSED_ATTACKS",
      qualified: false,
      reason: "participant_count_mismatch",
    };
  }
  return { goalId: "WAR_NO_MISSED_ATTACKS", qualified: true, reason: "qualified" };
}

/** Purpose: evaluate the sync goal only from an immutable ACTUAL readiness snapshot. */
export function evaluateSyncZeroDeviationGoal(
  input: SyncZeroDeviationGoalFacts,
): SyncZeroDeviationGoalEvaluation {
  if (Number(input.memberCount) !== 50) {
    return { goalId: "SYNC_ZERO_DEVIATION", qualified: false, reason: "member_count_mismatch" };
  }
  if (input.projectionComplete !== true) {
    return { goalId: "SYNC_ZERO_DEVIATION", qualified: false, reason: "projection_incomplete" };
  }
  if (
    input.deviationScore === null ||
    input.deviationScore === undefined ||
    !Number.isFinite(Number(input.deviationScore))
  ) {
    return { goalId: "SYNC_ZERO_DEVIATION", qualified: false, reason: "deviation_unavailable" };
  }
  if (Number(input.deviationScore) !== 0) {
    return { goalId: "SYNC_ZERO_DEVIATION", qualified: false, reason: "deviation_nonzero" };
  }
  return { goalId: "SYNC_ZERO_DEVIATION", qualified: true, reason: "qualified" };
}

function evaluateCommonLiveWarFacts(
  facts: LiveWarClanGoalFacts,
): LiveWarClanGoalEvaluation["reason"] | null {
  if (facts.warState !== "inWar") return "not_battle_day";
  if (facts.inferredMatchType !== false) return "classification_unsettled";
  return null;
}

/** Purpose: evaluate one live-war goal from already-authoritative current-war facts. */
export function evaluateLiveWarClanGoal(input: {
  goalId: LiveWarClanGoalId;
  facts: LiveWarClanGoalFacts;
}): LiveWarClanGoalEvaluation {
  const commonReason = evaluateCommonLiveWarFacts(input.facts);
  if (commonReason) {
    return { goalId: input.goalId, qualified: false, reason: commonReason };
  }

  const expectedMatchType = input.goalId === "BL_150_STARS" ? "BL" : "FWA";
  if (input.facts.matchType !== expectedMatchType) {
    return {
      goalId: input.goalId,
      qualified: false,
      reason: "match_type_mismatch",
    };
  }

  const expectedOutcome = input.goalId === "FWA_WIN_150_STARS" ? "WIN" :
    input.goalId === "BL_150_STARS" ? null : "LOSE";
  if (expectedOutcome && input.facts.outcome !== expectedOutcome) {
    return {
      goalId: input.goalId,
      qualified: false,
      reason: "outcome_mismatch",
    };
  }

  if (
    input.goalId === "FWA_LOSE_TRADITIONAL_100_STARS" &&
    input.facts.loseStyle !== "TRADITIONAL"
  ) {
    return {
      goalId: input.goalId,
      qualified: false,
      reason: "lose_style_mismatch",
    };
  }
  if (
    input.goalId === "FWA_LOSE_TOP30_90_CLEAN" &&
    input.facts.loseStyle !== "TRIPLE_TOP_30"
  ) {
    return {
      goalId: input.goalId,
      qualified: false,
      reason: "lose_style_mismatch",
    };
  }

  const threshold =
    input.goalId === "FWA_LOSE_TOP30_90_CLEAN" ? 90 :
    input.goalId === "FWA_WIN_150_STARS" || input.goalId === "BL_150_STARS" ? 150 : 100;
  if (!Number.isFinite(Number(input.facts.clanStars)) || Number(input.facts.clanStars) < threshold) {
    return {
      goalId: input.goalId,
      qualified: false,
      reason: "stars_below_threshold",
    };
  }

  if (input.goalId === "FWA_LOSE_TOP30_90_CLEAN") {
    if (input.facts.top30Clean === false) {
      return {
        goalId: input.goalId,
        qualified: false,
        reason: "top30_attack_on_bottom_20",
      };
    }
    if (input.facts.top30Clean !== true) {
      return {
        goalId: input.goalId,
        qualified: false,
        reason: "attack_cleanliness_not_checked",
        requiresAttackCleanliness: true,
      };
    }
  }

  return { goalId: input.goalId, qualified: true, reason: "qualified" };
}

/** Purpose: evaluate all live-war goals without deriving match classification or outcome. */
export function evaluateLiveWarClanGoals(
  facts: LiveWarClanGoalFacts,
): readonly LiveWarClanGoalEvaluation[] {
  return LIVE_WAR_CLAN_GOAL_IDS.map((goalId) =>
    evaluateLiveWarClanGoal({ goalId, facts }),
  );
}

function normalizeIdentityPart(input: string | number | null | undefined): string {
  return String(input ?? "").trim() || "unknown";
}

function normalizeClanTag(input: string): string {
  return normalizeClashTagInput(input);
}

/** Purpose: choose a stable catalog snippet without relying on process randomness. */
export function selectClanGoalSnippet(input: ClanGoalEventIdentity & { goalId: ClanGoalId }): string {
  const definition = CLAN_GOAL_BY_ID.get(input.goalId);
  if (!definition) {
    throw new Error(`UNKNOWN_CLAN_GOAL_ID:${input.goalId}`);
  }

  const seed = [
    input.goalId,
    normalizeIdentityPart(input.guildId),
    normalizeClanTag(input.clanTag),
    normalizeIdentityPart(input.warId),
    normalizeIdentityPart(input.syncIdentity),
  ].join("|");

  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return definition.snippets[(hash >>> 0) % definition.snippets.length];
}

/** Purpose: expose an immutable snapshot of the canonical goal catalog. */
export function getClanGoalCatalog(): readonly ClanGoalDefinition[] {
  return CLAN_GOAL_CATALOG;
}

/** Purpose: look up one canonical goal definition for future trigger services. */
export function getClanGoalDefinition(goalId: ClanGoalId): ClanGoalDefinition {
  const definition = CLAN_GOAL_BY_ID.get(goalId);
  if (!definition) {
    throw new Error(`UNKNOWN_CLAN_GOAL_ID:${goalId}`);
  }
  return definition;
}

/** Purpose: render a non-pinging clan-goal notification without sending it. */
export function renderClanGoalMessage(
  input: ClanGoalEventIdentity & {
    goalId: ClanGoalId;
    clanName?: string | null;
  },
): ClanGoalRenderedMessage {
  const definition = getClanGoalDefinition(input.goalId);
  const clanLabel = input.clanName?.trim()
    ? `${input.clanName.trim()} (${normalizeClanTag(input.clanTag)})`
    : normalizeClanTag(input.clanTag);
  return {
    content: `🏆 **${definition.label}** — ${clanLabel}\n${selectClanGoalSnippet(input)}`,
    allowedMentions: { parse: [] },
  };
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return /^\d+$/.test(value) ? value : null;
}

/** Purpose: resolve clan-goal destinations using the shared routed bot-log modes. */
export function resolveClanGoalDestination(input: {
  routingConfig: Pick<RoutedBotLogRoutingConfig, "routingMode"> & {
    channelId?: string | null;
  };
  clanLogChannelId?: string | null;
  clanLeaderChannelId?: string | null;
  botLogChannelId?: string | null;
}): ClanGoalDestinationResolution {
  const mode = input.routingConfig.routingMode;
  if (mode === "DISABLED") {
    return { channelId: null, source: null, skipReason: "disabled" };
  }

  const candidates: Record<Exclude<ClanGoalRoutingSource, "custom">, string | null> = {
    clan_log: normalizeChannelId(input.clanLogChannelId),
    clan_lead: normalizeChannelId(input.clanLeaderChannelId),
    bot_log: normalizeChannelId(input.botLogChannelId),
  };
  if (mode === "CLAN_LOG") {
    return candidates.clan_log
      ? { channelId: candidates.clan_log, source: "clan_log" }
      : { channelId: null, source: null, skipReason: "missing_clan_log_channel" };
  }
  if (mode === "CLAN_LEAD") {
    return candidates.clan_lead
      ? { channelId: candidates.clan_lead, source: "clan_lead" }
      : { channelId: null, source: null, skipReason: "missing_clan_lead_channel" };
  }
  if (mode === "BOT_LOG") {
    return candidates.bot_log
      ? { channelId: candidates.bot_log, source: "bot_log" }
      : { channelId: null, source: null, skipReason: "missing_bot_log_channel" };
  }

  const customChannelId = normalizeChannelId(input.routingConfig.channelId);
  return customChannelId
    ? { channelId: customChannelId, source: "custom" }
    : { channelId: null, source: null, skipReason: "missing_custom_channel" };
}

/** Purpose: load the configured clan-goal route for a guild without owning goal state. */
export async function getClanGoalRoutingConfig(
  guildId: string,
  service: BotLogChannelService = botLogChannelService,
): Promise<RoutedBotLogRoutingConfig> {
  return service.getRoutingConfigForType(guildId, "clan-goals");
}

export type ClanGoalOutcome = "success" | "skip" | "failure";

/** Purpose: emit structured future-trigger telemetry while keeping this foundation side-effect free. */
export function logClanGoalOutcome(input: {
  outcome: ClanGoalOutcome;
  event: string;
  goalId: ClanGoalId;
  identity: ClanGoalEventIdentity;
  reason?: string;
  error?: unknown;
}): void {
  const errorText = input.error instanceof Error ? input.error.message : input.error;
  const suffix = [
    `event=${input.event}`,
    `outcome=${input.outcome}`,
    `goal_id=${input.goalId}`,
    `guild_id=${normalizeIdentityPart(input.identity.guildId)}`,
    `clan_tag=${normalizeClanTag(input.identity.clanTag)}`,
    `war_id=${normalizeIdentityPart(input.identity.warId)}`,
    `sync_identity=${normalizeIdentityPart(input.identity.syncIdentity)}`,
    `reason=${input.reason ?? "none"}`,
    ...(errorText ? [`error=${String(errorText).replace(/\s+/g, " ").slice(0, 200)}`] : []),
  ].join(" ");
  const line = `[clan-goals] ${suffix}`;
  const quietSkipReasons = new Set([
    "disabled",
    "already_delivered",
    "reservation_in_flight",
    "reservation_already_claimed",
    "missing_history",
    "history_not_ended",
    "history_war_mismatch",
    "history_clan_mismatch",
    "history_match_type_mismatch",
    "evaluation_missing",
    "evaluation_identity_mismatch",
    "evaluation_not_completed",
    "violations_present",
    "participation_missing",
    "participant_count_missing",
    "participant_count_mismatch",
    "participant_identity_mismatch",
    "participant_roster_incomplete",
    "missed_attacks_present",
  ]);
  if (input.outcome === "failure") {
    console.error(line);
  } else if (input.outcome === "skip") {
    if (quietSkipReasons.has(input.reason ?? "")) console.debug(line);
    else console.warn(line);
  } else {
    console.info(line);
  }
}

export class ClanGoalService {
  /** Purpose: expose the canonical catalog to future goal evaluators. */
  getCatalog(): readonly ClanGoalDefinition[] {
    return getClanGoalCatalog();
  }

  /** Purpose: select deterministic event text for a future goal notification. */
  selectSnippet(input: ClanGoalEventIdentity & { goalId: ClanGoalId }): string {
    return selectClanGoalSnippet(input);
  }

  /** Purpose: render future goal notification content with mentions disabled. */
  renderMessage(
    input: ClanGoalEventIdentity & { goalId: ClanGoalId; clanName?: string | null },
  ): ClanGoalRenderedMessage {
    return renderClanGoalMessage(input);
  }

  /** Purpose: resolve a future goal notification destination without posting. */
  resolveDestination(input: Parameters<typeof resolveClanGoalDestination>[0]): ClanGoalDestinationResolution {
    return resolveClanGoalDestination(input);
  }
}

export const clanGoalService = new ClanGoalService();
