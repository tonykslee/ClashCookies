import { repWorkActivityService, type RepWorkActivityAuditEvent } from "./RepWorkActivityService";
import {
  classifyFwaRepWorkEvent,
  isSimulationDate,
  normalizeSimulationDiscordUserId,
  startOfSimulationUtcWeek,
  validateHistoricalSimulationScope,
  type HistoricalEarningsSimulationScope,
  type HistoricalRepWorkEventRow,
} from "./duskHistoricalEarningsSimulation";

/** Draft simulation inputs only; these values are not approved issuance policy. */
export const DUSK_REP_WORK_SIMULATION_RATE = 2;
export const DUSK_REP_WORK_SIMULATION_WEEKLY_CAP = 30;
export const DUSK_REP_WORK_EVALUATION_MAX_EVENTS = 10_000;

export type DuskRepWorkRewardClassification = "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";

export type DuskRepWorkRewardReasonCode =
  | "RECOGNIZED_FWA_REP_WORK"
  | "DUPLICATE_DEDUPE_KEY"
  | "REP_EVENT_DEDUPE_CONFLICT"
  | "REP_EVENT_ID_MISSING"
  | "REP_EVENT_TIME_INVALID"
  | "REP_EVENT_DEDUPE_MISSING"
  | "REP_EVENT_USER_INVALID"
  | "REP_EVENT_CWL_SOURCE"
  | "REP_EVENT_SOURCE_UNKNOWN";

export type DuskRepWorkSourceCorrectionStatus = "NONE" | "OBSERVED_UPDATE_NOT_PROVEN_CORRECTION";

export type DuskRepWorkRewardEvent = {
  sourceEventId: string | null;
  canonicalDedupeKey: string | null;
  classification: DuskRepWorkRewardClassification;
  reasonCode: DuskRepWorkRewardReasonCode;
  discordUserId: string | null;
  activityType: string;
  source: string | null;
  clanTag: string;
  syncMessageId: string | null;
  sourceMessageId: string;
  sourceTrackedMessageId: string | null;
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string | null;
  eventAt: Date | null;
  sourceMetadata: unknown;
  sourceCorrectionStatus: DuskRepWorkSourceCorrectionStatus;
  simulationOnlyDuskits: number;
};

export type DuskRepWorkRewardUserWeek = {
  discordUserId: string;
  eligibleEventCount: number;
  sourceEventIds: string[];
  uncappedSimulationOnlyDuskits: number;
  cappedSimulationOnlyDuskits: number;
};

export type DuskRepWorkRewardWeek = {
  weekStart: string;
  users: DuskRepWorkRewardUserWeek[];
  totalUncappedSimulationOnlyDuskits: number;
  totalCappedSimulationOnlyDuskits: number;
};

export type DuskRepWorkRewardEvaluation = {
  evaluator: "dusk-rep-work-reward-evaluator";
  evaluatorVersion: "2";
  readOnly: true;
  scope: {
    guildId: string;
    from: string;
    to: string;
    snapshotAt: string;
    completeUtcWeeks: number;
  };
  policy: {
    rateDuskits: number;
    weeklyCapDuskits: number;
    status: "SIMULATION_ONLY_NOT_APPROVED";
  };
  summary: {
    sourceRows: number;
    eligibleEvents: number;
    ineligibleEvents: number;
    unknownEvents: number;
    duplicateEvents: number;
    eligibleUsers: number;
    uncappedSimulationOnlyDuskits: number;
    cappedSimulationOnlyDuskits: number;
    observedSourceUpdates: number;
    provenCorrectionRows: number;
  };
  events: DuskRepWorkRewardEvent[];
  weekly: DuskRepWorkRewardWeek[];
};

export type DuskRepWorkRewardEvaluationInput = {
  scope: HistoricalEarningsSimulationScope;
  events: readonly HistoricalRepWorkEventRow[];
};

export type DuskRepWorkRewardEvaluationScope = HistoricalEarningsSimulationScope;

export type DuskRepWorkRewardEvaluationStore = {
  listEventsForEvaluation(input: {
    guildId: string;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<readonly RepWorkActivityAuditEvent[]>;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result || null;
}

function sourceCorrectionStatus(event: HistoricalRepWorkEventRow): DuskRepWorkSourceCorrectionStatus {
  return isSimulationDate(event.createdAt) && isSimulationDate(event.updatedAt) && event.updatedAt.getTime() > event.createdAt.getTime()
    ? "OBSERVED_UPDATE_NOT_PROVEN_CORRECTION"
    : "NONE";
}

function sortEvents(events: readonly HistoricalRepWorkEventRow[]): HistoricalRepWorkEventRow[] {
  return [...events].sort((left, right) => {
    const leftTime = isSimulationDate(left.eventAt) ? left.eventAt.getTime() : Number.POSITIVE_INFINITY;
    const rightTime = isSimulationDate(right.eventAt) ? right.eventAt.getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    const idComparison = text(left.id).localeCompare(text(right.id));
    if (idComparison !== 0) return idComparison;
    const sourceMessageComparison = text(left.sourceMessageId).localeCompare(text(right.sourceMessageId));
    if (sourceMessageComparison !== 0) return sourceMessageComparison;
    return JSON.stringify(left.metadata ?? null).localeCompare(JSON.stringify(right.metadata ?? null));
  });
}

type DuskRepWorkRewardEvidence = {
  classification: DuskRepWorkRewardClassification;
  reasonCode: DuskRepWorkRewardReasonCode;
  source: string | null;
  attribution: string | null;
  sourceSignature: string;
  authoritativeContextSignature: string;
};

function canonicalContextText(value: unknown): string {
  const normalized = nullableText(value);
  return normalized ? normalized.toUpperCase() : "<MISSING>";
}

function canonicalDateContext(value: unknown): string {
  if (value === null || value === undefined) return "<MISSING>";
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return "<INVALID>";
  return value.toISOString();
}

function metadataContextText(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "<MISSING>";
  return canonicalContextText((metadata as Record<string, unknown>)[key]);
}

/**
 * Same-key rows are equivalent only when their persisted event identity and
 * authoritative context agree. Optional fields are equivalent when absent on
 * both rows; missing-versus-present is conservatively treated as a conflict.
 */
function authoritativeContextSignature(event: HistoricalRepWorkEventRow): string {
  return [
    `activity=${canonicalContextText(event.activityType)}`,
    `eventAt=${canonicalDateContext(event.eventAt)}`,
    `clan=${canonicalContextText(event.clanTag)}`,
    `sync=${canonicalContextText(event.syncMessageId)}`,
    `sourceMessage=${canonicalContextText(event.sourceMessageId)}`,
    `sourceTrackedMessage=${canonicalContextText(event.sourceTrackedMessageId)}`,
    `war=${canonicalContextText(event.warId)}`,
    `warStart=${canonicalDateContext(event.warStartTime)}`,
    `opponent=${canonicalContextText(event.opponentTag)}`,
    `metadataSource=${metadataContextText(event.metadata, "source")}`,
    `metadataClanKind=${metadataContextText(event.metadata, "clanKind")}`,
    `metadataViewType=${metadataContextText(event.metadata, "viewType")}`,
  ].join("|");
}

function classifyEventEvidence(event: HistoricalRepWorkEventRow): DuskRepWorkRewardEvidence {
  const attribution = normalizeSimulationDiscordUserId(event.discordUserId);
  if (!nullableText(event.id)) {
    return { classification: "UNKNOWN", reasonCode: "REP_EVENT_ID_MISSING", source: null, attribution, sourceSignature: "invalid:id", authoritativeContextSignature: authoritativeContextSignature(event) };
  }
  if (!isSimulationDate(event.eventAt)) {
    return { classification: "UNKNOWN", reasonCode: "REP_EVENT_TIME_INVALID", source: null, attribution, sourceSignature: "invalid:time", authoritativeContextSignature: authoritativeContextSignature(event) };
  }
  if (!nullableText(event.dedupeKey)) {
    return { classification: "UNKNOWN", reasonCode: "REP_EVENT_DEDUPE_MISSING", source: null, attribution, sourceSignature: "invalid:dedupe", authoritativeContextSignature: authoritativeContextSignature(event) };
  }
  if (!attribution) {
    return { classification: "UNKNOWN", reasonCode: "REP_EVENT_USER_INVALID", source: null, attribution, sourceSignature: "invalid:user", authoritativeContextSignature: authoritativeContextSignature(event) };
  }

  const sourceClassification = classifyFwaRepWorkEvent(event);
  if (sourceClassification.status !== "RECOGNIZED") {
    return {
      classification: "UNKNOWN",
      reasonCode: sourceClassification.reason,
      source: null,
      attribution,
      sourceSignature: `unknown:${sourceClassification.reason}`,
      authoritativeContextSignature: authoritativeContextSignature(event),
    };
  }
  return {
    classification: "ELIGIBLE",
    reasonCode: "RECOGNIZED_FWA_REP_WORK",
    source: sourceClassification.source,
    attribution,
    sourceSignature: `recognized:${sourceClassification.source}:${sourceClassification.isBaseSwapPublisher}`,
    authoritativeContextSignature: authoritativeContextSignature(event),
  };
}

function evaluateDedupeGroup(
  group: readonly HistoricalRepWorkEventRow[],
): DuskRepWorkRewardEvent[] {
  const ordered = sortEvents(group);
  const evidence = ordered.map((event) => classifyEventEvidence(event));
  if (ordered.length === 1) {
    const result = evidence[0];
    return [buildEventResult(ordered[0], result.classification, result.reasonCode, result.source, result.classification === "ELIGIBLE" ? DUSK_REP_WORK_SIMULATION_RATE : 0)];
  }

  const recognized = evidence.filter((item) => item.classification === "ELIGIBLE");
  const unknown = evidence.filter((item) => item.classification === "UNKNOWN");
  const attributionSet = new Set(evidence.map((item) => item.attribution).filter((value): value is string => Boolean(value)));
  const sourceSet = new Set(recognized.map((item) => item.sourceSignature));
  const contextSet = new Set(recognized.map((item) => item.authoritativeContextSignature));
  const hasConflictingEvidence = unknown.length > 0 || attributionSet.size > 1 || sourceSet.size > 1 || contextSet.size > 1;
  if (hasConflictingEvidence) {
    return ordered.map((event) => buildEventResult(event, "UNKNOWN", "REP_EVENT_DEDUPE_CONFLICT", null));
  }

  return ordered.map((event, index) => {
    const result = evidence[index];
    return buildEventResult(
      event,
      index === 0 ? "ELIGIBLE" : "INELIGIBLE",
      index === 0 ? "RECOGNIZED_FWA_REP_WORK" : "DUPLICATE_DEDUPE_KEY",
      index === 0 ? result.source : null,
      index === 0 ? DUSK_REP_WORK_SIMULATION_RATE : 0,
    );
  });
}

function buildEventResult(
  event: HistoricalRepWorkEventRow,
  classification: DuskRepWorkRewardClassification,
  reasonCode: DuskRepWorkRewardReasonCode,
  source: string | null,
  simulationOnlyDuskits = 0,
): DuskRepWorkRewardEvent {
  return {
    sourceEventId: nullableText(event.id),
    canonicalDedupeKey: nullableText(event.dedupeKey),
    classification,
    reasonCode,
    discordUserId: normalizeSimulationDiscordUserId(event.discordUserId),
    activityType: text(event.activityType),
    source,
    clanTag: text(event.clanTag),
    syncMessageId: nullableText(event.syncMessageId),
    sourceMessageId: text(event.sourceMessageId),
    sourceTrackedMessageId: nullableText(event.sourceTrackedMessageId),
    warId: nullableText(event.warId),
    warStartTime: isSimulationDate(event.warStartTime) ? event.warStartTime : null,
    opponentTag: nullableText(event.opponentTag),
    eventAt: isSimulationDate(event.eventAt) ? event.eventAt : null,
    sourceMetadata: event.metadata ?? null,
    sourceCorrectionStatus: sourceCorrectionStatus(event),
    simulationOnlyDuskits,
  };
}

function buildWeeklyResults(
  scope: HistoricalEarningsSimulationScope,
  eligibleEvents: readonly DuskRepWorkRewardEvent[],
): DuskRepWorkRewardWeek[] {
  const byWeek = new Map<string, Map<string, { sourceEventIds: string[]; count: number }>>();
  for (const event of eligibleEvents) {
    if (!event.eventAt || !event.discordUserId) continue;
    const weekStart = startOfSimulationUtcWeek(event.eventAt).toISOString();
    const byUser = byWeek.get(weekStart) ?? new Map<string, { sourceEventIds: string[]; count: number }>();
    const current = byUser.get(event.discordUserId) ?? { sourceEventIds: [], count: 0 };
    current.count += 1;
    if (event.sourceEventId) current.sourceEventIds.push(event.sourceEventId);
    byUser.set(event.discordUserId, current);
    byWeek.set(weekStart, byUser);
  }

  const weeks: DuskRepWorkRewardWeek[] = [];
  for (let time = scope.from.getTime(); time < scope.to.getTime(); time += 7 * 24 * 60 * 60 * 1000) {
    const weekStart = new Date(time).toISOString();
    const users = [...(byWeek.get(weekStart) ?? new Map())]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([discordUserId, value]) => ({
        discordUserId,
        eligibleEventCount: value.count,
        sourceEventIds: [...value.sourceEventIds].sort((left, right) => left.localeCompare(right)),
        uncappedSimulationOnlyDuskits: value.count * DUSK_REP_WORK_SIMULATION_RATE,
        cappedSimulationOnlyDuskits: Math.min(value.count * DUSK_REP_WORK_SIMULATION_RATE, DUSK_REP_WORK_SIMULATION_WEEKLY_CAP),
      }));
    weeks.push({
      weekStart,
      users,
      totalUncappedSimulationOnlyDuskits: users.reduce((sum, user) => sum + user.uncappedSimulationOnlyDuskits, 0),
      totalCappedSimulationOnlyDuskits: users.reduce((sum, user) => sum + user.cappedSimulationOnlyDuskits, 0),
    });
  }
  return weeks;
}

/** Purpose: deterministically classify bounded persisted FWA rep-work evidence without issuing or mutating rewards. */
export function evaluateDuskRepWorkRewards(input: DuskRepWorkRewardEvaluationInput): DuskRepWorkRewardEvaluation {
  const completeUtcWeeks = validateHistoricalSimulationScope(input.scope);
  const guildId = text(input.scope.guildId);
  const inScopeEvents = input.events.filter((event) => {
    if (text(event.guildId) !== guildId) return false;
    if (!isSimulationDate(event.eventAt)) return true;
    return event.eventAt >= input.scope.from && event.eventAt < input.scope.to;
  });
  if (inScopeEvents.length > DUSK_REP_WORK_EVALUATION_MAX_EVENTS) {
    throw new Error("Rep-work evaluation input exceeds its bounded event limit.");
  }

  const groups = new Map<string, HistoricalRepWorkEventRow[]>();
  const ungroupedEvents: HistoricalRepWorkEventRow[] = [];
  for (const event of inScopeEvents) {
    const dedupeKey = nullableText(event.dedupeKey);
    if (!dedupeKey) {
      ungroupedEvents.push(event);
      continue;
    }
    const group = groups.get(dedupeKey) ?? [];
    group.push(event);
    groups.set(dedupeKey, group);
  }

  const evaluatedEvents: DuskRepWorkRewardEvent[] = [];
  let observedSourceUpdates = 0;
  for (const event of inScopeEvents) {
    if (sourceCorrectionStatus(event) !== "NONE") observedSourceUpdates += 1;
  }
  for (const group of groups.values()) evaluatedEvents.push(...evaluateDedupeGroup(group));
  for (const event of ungroupedEvents) {
    const result = classifyEventEvidence(event);
    evaluatedEvents.push(buildEventResult(event, result.classification, result.reasonCode, result.source, result.classification === "ELIGIBLE" ? DUSK_REP_WORK_SIMULATION_RATE : 0));
  }
  evaluatedEvents.sort((left, right) => {
    const leftTime = left.eventAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightTime = right.eventAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return text(left.sourceEventId).localeCompare(text(right.sourceEventId)) || text(left.sourceMessageId).localeCompare(text(right.sourceMessageId));
  });

  const eligibleEvents = evaluatedEvents.filter((event) => event.classification === "ELIGIBLE");
  const weekly = buildWeeklyResults(input.scope, eligibleEvents);
  const eligibleUsers = new Set(eligibleEvents.map((event) => event.discordUserId).filter((value): value is string => Boolean(value)));
  return {
    evaluator: "dusk-rep-work-reward-evaluator",
    evaluatorVersion: "2",
    readOnly: true,
    scope: {
      guildId,
      from: input.scope.from.toISOString(),
      to: input.scope.to.toISOString(),
      snapshotAt: input.scope.snapshotAt.toISOString(),
      completeUtcWeeks,
    },
    policy: {
      rateDuskits: DUSK_REP_WORK_SIMULATION_RATE,
      weeklyCapDuskits: DUSK_REP_WORK_SIMULATION_WEEKLY_CAP,
      status: "SIMULATION_ONLY_NOT_APPROVED",
    },
    summary: {
      sourceRows: evaluatedEvents.length,
      eligibleEvents: eligibleEvents.length,
      ineligibleEvents: evaluatedEvents.filter((event) => event.classification === "INELIGIBLE").length,
      unknownEvents: evaluatedEvents.filter((event) => event.classification === "UNKNOWN").length,
      duplicateEvents: evaluatedEvents.filter((event) => event.reasonCode === "DUPLICATE_DEDUPE_KEY").length,
      eligibleUsers: eligibleUsers.size,
      uncappedSimulationOnlyDuskits: eligibleEvents.length * DUSK_REP_WORK_SIMULATION_RATE,
      cappedSimulationOnlyDuskits: weekly.reduce((sum, week) => sum + week.totalCappedSimulationOnlyDuskits, 0),
      observedSourceUpdates,
      provenCorrectionRows: 0,
    },
    events: evaluatedEvents,
    weekly,
  };
}

/** Purpose: load one bounded persisted evidence window and evaluate it without calling any wallet mutation path. */
export async function evaluateDuskRepWorkRewardsFromStore(
  scope: HistoricalEarningsSimulationScope,
  store: DuskRepWorkRewardEvaluationStore = repWorkActivityService,
): Promise<DuskRepWorkRewardEvaluation> {
  validateHistoricalSimulationScope(scope);
  const events = await store.listEventsForEvaluation({
    guildId: scope.guildId,
    from: scope.from,
    to: scope.to,
    limit: DUSK_REP_WORK_EVALUATION_MAX_EVENTS,
  });
  return evaluateDuskRepWorkRewards({ scope, events });
}
