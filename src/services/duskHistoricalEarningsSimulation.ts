export const CLEAN_FWA_PARTICIPATION_DUSKITS = 4;
export const FWA_REP_ACTION_DUSKITS = 2;
export const ROUTINE_WEEKLY_CAP_DUSKITS = 30;
export const PERSONAL_TARGET_DUSKITS = 100;
export const MAX_SIMULATION_WEEKS = 12;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type SimulationStatus = "VERIFIED" | "PROVISIONAL" | "INELIGIBLE" | "UNKNOWN";

export type HistoricalEarningsSimulationScope = {
  guildId: string;
  from: Date;
  to: Date;
  snapshotAt: Date;
};

export type HistoricalWarRow = {
  warId: number;
  matchType: string | null;
  clanTag: string;
  opponentTag: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** The persisted schema has no completeness marker; production adapters must use UNKNOWN. */
  participationCompleteness?: "COMPLETE" | "UNKNOWN";
};

export type HistoricalParticipationRow = {
  guildId: string;
  warId: string;
  clanTag: string;
  opponentTag: string | null;
  playerTag: string;
  attacksUsed: number;
  attacksMissed: number;
  matchType: string;
  warStartTime: Date;
  warEndTime: Date | null;
  createdAt: Date;
};

export type HistoricalEvaluationRow = {
  guildId: string;
  warId: number;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  violations: Array<{
    id: string;
    playerTag: string;
  }>;
};

export type HistoricalPlayerLinkRow = {
  playerTag: string;
  discordUserId: string | null;
  linkSource: string;
  verificationStatus: string;
  verificationMethod: string | null;
  verifiedAt: Date | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HistoricalRepWorkEventRow = {
  guildId: string;
  activityType: string;
  discordUserId: string;
  clanTag: string;
  syncMessageId: string | null;
  sourceMessageId: string;
  warId: string | null;
  warStartTime: Date | null;
  eventAt: Date;
  dedupeKey: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type CurrentRepAssignmentRow = {
  clanTag: string;
  playerTag: string;
};

export type HistoricalEarningsSimulationInput = {
  scope: HistoricalEarningsSimulationScope;
  wars: readonly HistoricalWarRow[];
  participation: readonly HistoricalParticipationRow[];
  evaluations: readonly HistoricalEvaluationRow[];
  playerLinks: readonly HistoricalPlayerLinkRow[];
  repEvents: readonly HistoricalRepWorkEventRow[];
  currentRepAssignments?: readonly CurrentRepAssignmentRow[];
};

export type UnknownReason =
  | "WAR_IDENTITY_MISSING"
  | "WAR_IDENTITY_CONFLICT"
  | "WAR_ROSTER_MISSING"
  | "WAR_ROSTER_MALFORMED"
  | "WAR_ROSTER_COMPLETENESS_UNPROVEN"
  | "WAR_EVALUATION_MISSING"
  | "WAR_EVALUATION_INCOMPLETE"
  | "PLAYER_LINK_MISSING"
  | "PLAYER_LINK_CREATED_AFTER_EVENT"
  | "PLAYER_LINK_NOT_VERIFIED_AT_EVENT"
  | "PLAYER_LINK_REVOKED"
  | "PLAYER_LINK_HISTORY_SENSITIVE"
  | "PLAYER_IDENTITY_CONFLICT"
  | "REP_EVENT_TIME_INVALID"
  | "REP_EVENT_DEDUPE_MISSING"
  | "REP_EVENT_SOURCE_UNKNOWN"
  | "REP_EVENT_CWL_SOURCE"
  | "REP_EVENT_USER_INVALID";

export type SimulationReasonCounts = Partial<Record<UnknownReason, number>>;

export type WeeklyDistribution = {
  weekStart: string;
  strict: DistributionSummary;
  provisional: DistributionSummary;
};

export type DistributionSummary = {
  userCount: number;
  totalUncappedDuskits: number;
  totalCappedDuskits: number;
  minUncappedDuskits: number;
  medianUncappedDuskits: number;
  maxUncappedDuskits: number;
  usersAtOrAbove15: number;
  usersAtOrAbove20: number;
};

export type HistoricalEarningsSimulationReport = {
  scope: {
    guildId: string;
    from: string;
    to: string;
    snapshotAt: string;
    completeUtcWeeks: number;
  };
  assumptions: {
    cleanFwaDuskits: number;
    repActionDuskits: number;
    routineWeeklyCapDuskits: number;
    personalTargetDuskits: number;
    participationRule: "attacksUsed>0_and_attacksMissed=0";
    strictLinkRule: string;
    provisionalLinkRule: string;
  };
  coverage: {
    endedWarScope: number;
    warIdsWithParticipation: number;
    canonicalRosterComplete: number;
    canonicalRosterUnknown: number;
    completedEvaluations: number;
    incompleteOrMissingEvaluations: number;
    playerViolationRows: number;
    playerRowsConsidered: number;
    strictVerifiedLinks: number;
    provisionalLinks: number;
    missingLinks: number;
    lateLinks: number;
    revokedLinks: number;
    historicalOwnershipSensitiveLinks: number;
    duplicatePlayerIdentities: number;
    repEventRows: number;
    recognizedFwaRepEvents: number;
    unknownRepEventRows: number;
    duplicateRepEvents: number;
    correctedSourceRows: number;
    currentRepUsers: number;
    currentNonRepUsers: number;
  };
  cleanFwa: ActivityDiagnosticCounts;
  repWork: ActivityDiagnosticCounts & {
    sourceCounts: Record<string, number>;
    baseSwapPublisherEvents: number;
  };
  unknownReasons: SimulationReasonCounts;
  weekly: WeeklyDistribution[];
  targetFeasibility: {
    strictUsers: number;
    provisionalUsers: number;
    strictUsersAtOrAbove15Average: number;
    strictUsersAtOrAbove20Average: number;
    provisionalUsersAtOrAbove15Average: number;
    provisionalUsersAtOrAbove20Average: number;
    strictUsersReaching100Within5Weeks: number;
    strictUsersReaching100Within7Weeks: number;
    provisionalUsersReaching100Within5Weeks: number;
    provisionalUsersReaching100Within7Weeks: number;
  };
  unmodeledGaps: string[];
};

export type ActivityDiagnosticCounts = {
  eventRows: number;
  verifiedEvents: number;
  provisionalEvents: number;
  ineligibleEvents: number;
  unknownEvents: number;
  duplicateEvents: number;
  strictDuskits: number;
  provisionalDuskits: number;
};

type LinkClassification = {
  status: "STRICT" | "PROVISIONAL" | "UNKNOWN";
  discordUserId: string | null;
  reason?: UnknownReason;
  historicalSensitive: boolean;
  accountTag: string;
};

type CandidateEvent = {
  userId: string;
  accountTag: string | null;
  weekStart: string;
  sourceKey: string;
  duskits: number;
  strict: boolean;
  provisional: boolean;
};

type MutableActivityCounts = ActivityDiagnosticCounts;

/** Purpose: normalize Clash tags without allowing name-like values into joins. */
export function normalizeSimulationTag(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return "";
  return text.startsWith("#") ? text : `#${text}`;
}

/** Purpose: normalize a Discord user ID for aggregate-only simulation attribution. */
export function normalizeSimulationDiscordUserId(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{15,22}$/.test(text) ? text : null;
}

/** Purpose: accept only valid finite dates from persisted rows or test fixtures. */
export function isSimulationDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: return the Monday 00:00 UTC bucket used by PostgreSQL DATE_TRUNC('week'). */
export function startOfSimulationUtcWeek(value: Date): Date {
  if (!isSimulationDate(value)) throw new Error("A valid date is required.");
  const result = new Date(value);
  const day = result.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

/** Purpose: validate an operator-selected bounded complete-UTC-week window. */
export function validateHistoricalSimulationScope(scope: HistoricalEarningsSimulationScope): number {
  if (!String(scope.guildId ?? "").trim()) throw new Error("--guild requires one explicit guild ID.");
  if (!isSimulationDate(scope.from) || !isSimulationDate(scope.to) || !isSimulationDate(scope.snapshotAt)) {
    throw new Error("Simulation dates must be valid finite dates.");
  }
  if (scope.from.getUTCDay() !== 1 || scope.from.getUTCHours() !== 0 || scope.from.getUTCMinutes() !== 0 || scope.from.getUTCSeconds() !== 0 || scope.from.getUTCMilliseconds() !== 0) {
    throw new Error("--from must be Monday 00:00:00.000 UTC for a complete week window.");
  }
  if (scope.to.getUTCDay() !== 1 || scope.to.getUTCHours() !== 0 || scope.to.getUTCMinutes() !== 0 || scope.to.getUTCSeconds() !== 0 || scope.to.getUTCMilliseconds() !== 0) {
    throw new Error("--to must be Monday 00:00:00.000 UTC for a complete week window.");
  }
  const durationMs = scope.to.getTime() - scope.from.getTime();
  if (durationMs <= 0 || durationMs % WEEK_MS !== 0) throw new Error("Simulation window must contain complete UTC weeks.");
  const weeks = durationMs / WEEK_MS;
  if (weeks > MAX_SIMULATION_WEEKS) throw new Error(`Simulation window may cover at most ${MAX_SIMULATION_WEEKS} complete UTC weeks.`);
  if (scope.to.getTime() > scope.snapshotAt.getTime()) throw new Error("--to cannot be later than the simulation snapshot time.");
  return weeks;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function incrementReason(map: SimulationReasonCounts, key: UnknownReason): void {
  map[key] = (map[key] ?? 0) + 1;
}

function emptyActivityCounts(): MutableActivityCounts {
  return {
    eventRows: 0,
    verifiedEvents: 0,
    provisionalEvents: 0,
    ineligibleEvents: 0,
    unknownEvents: 0,
    duplicateEvents: 0,
    strictDuskits: 0,
    provisionalDuskits: 0,
  };
}

function comparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function sameDate(left: Date | null | undefined, right: Date | null | undefined): boolean {
  return isSimulationDate(left) && isSimulationDate(right) && left.getTime() === right.getTime();
}

function validWarId(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function classifyPlayerLink(
  link: HistoricalPlayerLinkRow | undefined,
  playerTag: string,
  eventAt: Date,
): LinkClassification {
  if (!link) return { status: "UNKNOWN", discordUserId: null, reason: "PLAYER_LINK_MISSING", historicalSensitive: false, accountTag: playerTag };
  const discordUserId = normalizeSimulationDiscordUserId(link.discordUserId);
  if (!discordUserId) return { status: "UNKNOWN", discordUserId: null, reason: "PLAYER_LINK_MISSING", historicalSensitive: false, accountTag: playerTag };
  if (comparable(link.verificationStatus) === "REVOKED") return { status: "UNKNOWN", discordUserId, reason: "PLAYER_LINK_REVOKED", historicalSensitive: false, accountTag: playerTag };
  if (!isSimulationDate(link.createdAt) || link.createdAt.getTime() > eventAt.getTime()) {
    return { status: "UNKNOWN", discordUserId, reason: "PLAYER_LINK_CREATED_AFTER_EVENT", historicalSensitive: false, accountTag: playerTag };
  }

  const verified = comparable(link.verificationStatus) === "VERIFIED";
  const verifiedAt = link.verifiedAt ?? link.lastVerifiedAt;
  if (verified && (!isSimulationDate(verifiedAt) || verifiedAt.getTime() > eventAt.getTime())) {
    return { status: "UNKNOWN", discordUserId, reason: "PLAYER_LINK_NOT_VERIFIED_AT_EVENT", historicalSensitive: false, accountTag: playerTag };
  }

  const historicalSensitive = isSimulationDate(link.updatedAt) && link.updatedAt.getTime() > eventAt.getTime();
  if (verified && !historicalSensitive) {
    return { status: "STRICT", discordUserId, historicalSensitive: false, accountTag: playerTag };
  }
  return {
    status: "PROVISIONAL",
    discordUserId,
    reason: historicalSensitive ? "PLAYER_LINK_HISTORY_SENSITIVE" : undefined,
    historicalSensitive,
    accountTag: playerTag,
  };
}

function buildLinksByTag(links: readonly HistoricalPlayerLinkRow[]): {
  byTag: Map<string, HistoricalPlayerLinkRow>;
  conflicts: Set<string>;
  duplicateRows: number;
} {
  const byTag = new Map<string, HistoricalPlayerLinkRow>();
  const owners = new Map<string, Set<string>>();
  let duplicateRows = 0;
  for (const link of links) {
    const tag = normalizeSimulationTag(link.playerTag);
    if (!tag) continue;
    const users = owners.get(tag) ?? new Set<string>();
    const userId = normalizeSimulationDiscordUserId(link.discordUserId);
    if (userId) users.add(userId);
    owners.set(tag, users);
    if (byTag.has(tag)) duplicateRows += 1;
    else byTag.set(tag, link);
  }
  const conflicts = new Set([...owners.entries()].filter(([, users]) => users.size > 1).map(([tag]) => tag));
  return { byTag, conflicts, duplicateRows };
}

function isCompleteCanonicalRoster(rows: readonly HistoricalParticipationRow[]): boolean {
  if (rows.length === 0) return false;
  const keys = new Set<string>();
  for (const row of rows) {
    const playerTag = normalizeSimulationTag(row.playerTag);
    const clanTag = normalizeSimulationTag(row.clanTag);
    const warId = validWarId(row.warId);
    if (!playerTag || !clanTag || !warId || !isSimulationDate(row.warStartTime) || !isSimulationDate(row.warEndTime)) return false;
    const key = `${warId}|${playerTag}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isKnownFwaRepEvent(event: HistoricalRepWorkEventRow): { source: string; isBaseSwapPublisher: boolean } | null {
  const metadata = parseMetadata(event.metadata);
  const source = comparable(metadata.source);
  const clanKind = comparable(metadata.clanKind);
  if (clanKind === "CWL") return null;
  if (comparable(event.activityType) === "BASES_CHECKED" && source === "BASE_SWAP") {
    if (clanKind !== "FWA") return null;
    return { source: source.toLowerCase(), isBaseSwapPublisher: true };
  }
  if (comparable(event.activityType) === "BASES_CHECKED" && source === "BASES_CHECKLIST" && comparable(metadata.viewType) === "BASES") {
    return { source: source.toLowerCase(), isBaseSwapPublisher: false };
  }
  if (comparable(event.activityType) === "MAIL_CHECKED" && source === "MAIL_CHECKLIST" && comparable(metadata.viewType) === "MAIL") {
    return { source: source.toLowerCase(), isBaseSwapPublisher: false };
  }
  if (comparable(event.activityType) === "MAIL_SENT" && source === "FWA_MATCH_MAIL_SEND") {
    return { source: source.toLowerCase(), isBaseSwapPublisher: false };
  }
  return null;
}

function buildDistribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) {
    return { userCount: 0, totalUncappedDuskits: 0, totalCappedDuskits: 0, minUncappedDuskits: 0, medianUncappedDuskits: 0, maxUncappedDuskits: 0, usersAtOrAbove15: 0, usersAtOrAbove20: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    userCount: sorted.length,
    totalUncappedDuskits: sorted.reduce((sum, value) => sum + value, 0),
    totalCappedDuskits: sorted.reduce((sum, value) => sum + Math.min(value, ROUTINE_WEEKLY_CAP_DUSKITS), 0),
    minUncappedDuskits: sorted[0],
    medianUncappedDuskits: median,
    maxUncappedDuskits: sorted[sorted.length - 1],
    usersAtOrAbove15: sorted.filter((value) => value >= 15).length,
    usersAtOrAbove20: sorted.filter((value) => value >= 20).length,
  };
}

function computeWeeklyDistribution(
  scope: HistoricalEarningsSimulationScope,
  strictCandidates: readonly CandidateEvent[],
  provisionalCandidates: readonly CandidateEvent[],
): WeeklyDistribution[] {
  const weeks: WeeklyDistribution[] = [];
  for (let time = scope.from.getTime(); time < scope.to.getTime(); time += WEEK_MS) {
    const weekStart = new Date(time).toISOString();
    const strictByUser = new Map<string, number>();
    const provisionalByUser = new Map<string, number>();
    for (const candidate of strictCandidates) {
      if (candidate.weekStart === weekStart) increment(strictByUser, candidate.userId, candidate.duskits);
    }
    for (const candidate of provisionalCandidates) {
      if (candidate.weekStart === weekStart) increment(provisionalByUser, candidate.userId, candidate.duskits);
    }
    weeks.push({
      weekStart,
      strict: buildDistribution([...strictByUser.values()]),
      provisional: buildDistribution([...provisionalByUser.values()]),
    });
  }
  return weeks;
}

function calculateTargetFeasibility(
  weeks: readonly WeeklyDistribution[],
  strictCandidates: readonly CandidateEvent[],
  provisionalCandidates: readonly CandidateEvent[],
): HistoricalEarningsSimulationReport["targetFeasibility"] {
  const cappedTotals = (candidates: readonly CandidateEvent[]): Map<string, number> => {
    const byUserWeek = new Map<string, number>();
    for (const candidate of candidates) {
      increment(byUserWeek, `${candidate.userId}|${candidate.weekStart}`, candidate.duskits);
    }
    const byUser = new Map<string, number>();
    for (const [key, value] of byUserWeek) {
      const separator = key.lastIndexOf("|");
      increment(byUser, key.slice(0, separator), Math.min(value, ROUTINE_WEEKLY_CAP_DUSKITS));
    }
    return byUser;
  };
  const strictTotals = cappedTotals(strictCandidates);
  const provisionalTotals = cappedTotals(provisionalCandidates);
  const weekCount = weeks.length;
  const strictValues = [...strictTotals.values()];
  const provisionalValues = [...provisionalTotals.values()];
  const countAverageAtLeast = (values: readonly number[], threshold: number) => values.filter((value) => value / weekCount >= threshold).length;
  const countReaching = (values: readonly number[], weeksToTarget: number) => values.filter((value) => value / weekCount * weeksToTarget >= PERSONAL_TARGET_DUSKITS).length;
  return {
    strictUsers: strictValues.length,
    provisionalUsers: provisionalValues.length,
    strictUsersAtOrAbove15Average: countAverageAtLeast(strictValues, 15),
    strictUsersAtOrAbove20Average: countAverageAtLeast(strictValues, 20),
    provisionalUsersAtOrAbove15Average: countAverageAtLeast(provisionalValues, 15),
    provisionalUsersAtOrAbove20Average: countAverageAtLeast(provisionalValues, 20),
    strictUsersReaching100Within5Weeks: countReaching(strictValues, 5),
    strictUsersReaching100Within7Weeks: countReaching(strictValues, 7),
    provisionalUsersReaching100Within5Weeks: countReaching(provisionalValues, 5),
    provisionalUsersReaching100Within7Weeks: countReaching(provisionalValues, 7),
  };
}

/** Purpose: calculate strict and provisional aggregate earnings without exposing player identifiers. */
export function simulateHistoricalDuskits(input: HistoricalEarningsSimulationInput): HistoricalEarningsSimulationReport {
  const weeks = validateHistoricalSimulationScope(input.scope);
  const guildId = String(input.scope.guildId).trim();
  const histories = input.wars.filter((row) => row.warEndTime && row.warEndTime >= input.scope.from && row.warEndTime < input.scope.to);
  const historyById = new Map(histories.map((row) => [row.warId, row]));
  const participationByWar = new Map<number, HistoricalParticipationRow[]>();
  for (const row of input.participation) {
    if (String(row.guildId).trim() !== guildId) continue;
    const warId = validWarId(row.warId);
    if (!warId || !historyById.has(warId)) continue;
    const rows = participationByWar.get(warId) ?? [];
    rows.push(row);
    participationByWar.set(warId, rows);
  }
  const evaluationsByWar = new Map(input.evaluations.filter((row) => String(row.guildId).trim() === guildId).map((row) => [row.warId, row]));
  const links = buildLinksByTag(input.playerLinks);
  const unknownReasons: SimulationReasonCounts = {};
  const cleanFwa = emptyActivityCounts();
  const repWork: MutableActivityCounts & { sourceCounts: Record<string, number>; baseSwapPublisherEvents: number } = {
    ...emptyActivityCounts(),
    sourceCounts: {},
    baseSwapPublisherEvents: 0,
  };
  const strictCleanCandidates: CandidateEvent[] = [];
  const provisionalCleanCandidates: CandidateEvent[] = [];
  const strictRepCandidates: CandidateEvent[] = [];
  const provisionalRepCandidates: CandidateEvent[] = [];
  let canonicalRosterComplete = 0;
  let canonicalRosterUnknown = 0;
  let completedEvaluations = 0;
  let incompleteOrMissingEvaluations = 0;
  let playerViolationRows = 0;
  let playerRowsConsidered = 0;
  let strictVerifiedLinks = 0;
  let provisionalLinks = 0;
  let missingLinks = 0;
  let lateLinks = 0;
  let revokedLinks = 0;
  let historicalOwnershipSensitiveLinks = 0;
  let duplicatePlayerIdentities = links.duplicateRows + links.conflicts.size;
  let correctedSourceRows = histories.filter((row) => isSimulationDate(row.updatedAt) && isSimulationDate(row.createdAt) && row.updatedAt.getTime() > row.createdAt.getTime()).length;
  correctedSourceRows += input.evaluations.filter((row) => isSimulationDate(row.updatedAt) && isSimulationDate(row.createdAt) && row.updatedAt.getTime() > row.createdAt.getTime()).length;
  correctedSourceRows += input.repEvents.filter((row) => isSimulationDate(row.updatedAt) && isSimulationDate(row.createdAt) && row.updatedAt.getTime() > row.createdAt.getTime()).length;

  for (const history of histories) {
    const warId = history.warId;
    const participation = participationByWar.get(warId) ?? [];
    const rosterShapeValid = isCompleteCanonicalRoster(participation);
    const rosterComplete = history.participationCompleteness === "COMPLETE" && rosterShapeValid;
    if (rosterComplete) canonicalRosterComplete += 1;
    else {
      canonicalRosterUnknown += 1;
      incrementReason(
        unknownReasons,
        history.participationCompleteness !== "COMPLETE"
          ? "WAR_ROSTER_COMPLETENESS_UNPROVEN"
          : participation.length === 0
            ? "WAR_ROSTER_MISSING"
            : "WAR_ROSTER_MALFORMED",
      );
    }
    const evaluation = evaluationsByWar.get(warId);
    const evaluationComplete = comparable(evaluation?.status) === "COMPLETED" && isSimulationDate(evaluation?.completedAt);
    if (evaluationComplete) completedEvaluations += 1;
    else {
      incompleteOrMissingEvaluations += 1;
      incrementReason(unknownReasons, evaluation ? "WAR_EVALUATION_INCOMPLETE" : "WAR_EVALUATION_MISSING");
    }
    const violationsByPlayer = new Map<string, number>();
    for (const violation of evaluation?.violations ?? []) {
      const playerTag = normalizeSimulationTag(violation.playerTag);
      if (!playerTag) continue;
      increment(violationsByPlayer, playerTag);
      playerViolationRows += 1;
    }
    for (const row of participation) {
      playerRowsConsidered += 1;
      const playerTag = normalizeSimulationTag(row.playerTag);
      const identityExact = validWarId(row.warId) === warId &&
        normalizeSimulationTag(row.clanTag) === normalizeSimulationTag(history.clanTag) &&
        sameDate(row.warStartTime, history.warStartTime) &&
        sameDate(row.warEndTime, history.warEndTime) &&
        Boolean(row.opponentTag) && Boolean(history.opponentTag) &&
        normalizeSimulationTag(row.opponentTag) === normalizeSimulationTag(history.opponentTag);
      if (!identityExact) {
        cleanFwa.unknownEvents += 1;
        incrementReason(unknownReasons, "WAR_IDENTITY_CONFLICT");
        continue;
      }
      if (comparable(row.matchType) !== "FWA" || comparable(history.matchType) !== "FWA") {
        cleanFwa.ineligibleEvents += 1;
        continue;
      }
      if (!rosterComplete) {
        cleanFwa.unknownEvents += 1;
        continue;
      }
      if (!evaluationComplete) {
        cleanFwa.unknownEvents += 1;
        continue;
      }
      const violationCount = violationsByPlayer.get(playerTag) ?? 0;
      if (violationCount > 0) {
        cleanFwa.ineligibleEvents += 1;
        continue;
      }
      if (!(Number(row.attacksUsed) > 0 && Number(row.attacksMissed) === 0)) {
        cleanFwa.ineligibleEvents += 1;
        continue;
      }
      const link = classifyPlayerLink(links.byTag.get(playerTag), playerTag, history.warEndTime!);
      if (link.reason === "PLAYER_LINK_MISSING") missingLinks += 1;
      if (link.reason === "PLAYER_LINK_CREATED_AFTER_EVENT") lateLinks += 1;
      if (link.reason === "PLAYER_LINK_REVOKED") revokedLinks += 1;
      if (link.reason === "PLAYER_LINK_HISTORY_SENSITIVE") historicalOwnershipSensitiveLinks += 1;
      if (link.status === "STRICT") strictVerifiedLinks += 1;
      if (link.status === "PROVISIONAL") provisionalLinks += 1;
      if (links.conflicts.has(playerTag)) {
        cleanFwa.unknownEvents += 1;
        incrementReason(unknownReasons, "PLAYER_IDENTITY_CONFLICT");
        duplicatePlayerIdentities += 1;
        continue;
      }
      if (!link.discordUserId) {
        cleanFwa.unknownEvents += 1;
        incrementReason(unknownReasons, link.reason ?? "PLAYER_LINK_MISSING");
        continue;
      }
      if (link.status === "UNKNOWN") {
        cleanFwa.unknownEvents += 1;
        incrementReason(unknownReasons, link.reason ?? "PLAYER_LINK_MISSING");
        continue;
      }
      const candidate: CandidateEvent = {
        userId: link.discordUserId,
        accountTag: playerTag,
        weekStart: startOfSimulationUtcWeek(history.warEndTime!).toISOString(),
        sourceKey: `war:${warId}`,
        duskits: CLEAN_FWA_PARTICIPATION_DUSKITS,
        strict: link.status === "STRICT",
        provisional: true,
      };
      if (link.status === "STRICT") strictCleanCandidates.push(candidate);
      provisionalCleanCandidates.push(candidate);
      cleanFwa.verifiedEvents += link.status === "STRICT" ? 1 : 0;
      cleanFwa.provisionalEvents += 1;
    }
  }

  const seenRepKeys = new Set<string>();
  const repUserIds = new Set<string>();
  const repSourceCounts = new Map<string, number>();
  for (const event of input.repEvents) {
    if (String(event.guildId).trim() !== guildId || !isSimulationDate(event.eventAt) || event.eventAt < input.scope.from || event.eventAt >= input.scope.to) continue;
    repWork.eventRows += 1;
    const userId = normalizeSimulationDiscordUserId(event.discordUserId);
    if (!userId) {
      repWork.unknownEvents += 1;
      incrementReason(unknownReasons, "REP_EVENT_USER_INVALID");
      continue;
    }
    const source = isKnownFwaRepEvent(event);
    if (!source) {
      repWork.unknownEvents += 1;
      const metadata = parseMetadata(event.metadata);
      incrementReason(unknownReasons, comparable(metadata.clanKind) === "CWL" ? "REP_EVENT_CWL_SOURCE" : "REP_EVENT_SOURCE_UNKNOWN");
      continue;
    }
    if (!String(event.dedupeKey ?? "").trim()) {
      repWork.unknownEvents += 1;
      incrementReason(unknownReasons, "REP_EVENT_DEDUPE_MISSING");
      continue;
    }
    const dedupeKey = String(event.dedupeKey).trim();
    if (seenRepKeys.has(dedupeKey)) {
      repWork.duplicateEvents += 1;
      continue;
    }
    seenRepKeys.add(dedupeKey);
    repWork.verifiedEvents += 1;
    repWork.provisionalEvents += 1;
    repWork.strictDuskits += FWA_REP_ACTION_DUSKITS;
    repWork.provisionalDuskits += FWA_REP_ACTION_DUSKITS;
    increment(repSourceCounts, source.source);
    if (source.isBaseSwapPublisher) repWork.baseSwapPublisherEvents += 1;
    repUserIds.add(userId);
    const candidate: CandidateEvent = {
      userId,
      accountTag: null,
      weekStart: startOfSimulationUtcWeek(event.eventAt).toISOString(),
      sourceKey: `rep:${dedupeKey}`,
      duskits: FWA_REP_ACTION_DUSKITS,
      strict: true,
      provisional: true,
    };
    strictRepCandidates.push(candidate);
    provisionalRepCandidates.push(candidate);
  }

  const collapseWarAward = (candidates: readonly CandidateEvent[]): CandidateEvent[] => {
    const byUserWar = new Map<string, CandidateEvent>();
    for (const candidate of candidates.filter((row) => row.sourceKey.startsWith("war:"))) {
      const key = `${candidate.userId}|${candidate.weekStart}|${candidate.sourceKey}`;
      if (!byUserWar.has(key)) byUserWar.set(key, candidate);
    }
    return [...byUserWar.values()];
  };
  const strictCleanCollapsed = collapseWarAward(strictCleanCandidates);
  const provisionalCleanCollapsed = collapseWarAward(provisionalCleanCandidates);
  const strictFinal = [...strictCleanCollapsed, ...strictRepCandidates];
  const provisionalFinal = [...provisionalCleanCollapsed, ...provisionalRepCandidates];
  const weekly = computeWeeklyDistribution(input.scope, strictFinal, provisionalFinal);
  const targetFeasibility = calculateTargetFeasibility(weekly, strictFinal, provisionalFinal);

  const allUsers = new Set([...strictFinal.map((row) => row.userId), ...provisionalFinal.map((row) => row.userId)]);
  const tagsByUser = new Map<string, Set<string>>();
  for (const link of input.playerLinks) {
    const userId = normalizeSimulationDiscordUserId(link.discordUserId);
    const tag = normalizeSimulationTag(link.playerTag);
    if (!userId || !tag || !allUsers.has(userId)) continue;
    const tags = tagsByUser.get(userId) ?? new Set<string>();
    tags.add(tag);
    tagsByUser.set(userId, tags);
  }
  const repTags = new Set((input.currentRepAssignments ?? []).map((row) => normalizeSimulationTag(row.playerTag)).filter(Boolean));
  let currentRepUsers = 0;
  for (const tags of tagsByUser.values()) {
    if ([...tags].some((tag) => repTags.has(tag))) currentRepUsers += 1;
  }

  cleanFwa.eventRows = provisionalCleanCandidates.length;
  cleanFwa.verifiedEvents = strictCleanCollapsed.length;
  cleanFwa.provisionalEvents = provisionalCleanCollapsed.length;
  cleanFwa.duplicateEvents = Math.max(0, provisionalCleanCandidates.length - provisionalCleanCollapsed.length);
  cleanFwa.strictDuskits = strictCleanCollapsed.length * CLEAN_FWA_PARTICIPATION_DUSKITS;
  cleanFwa.provisionalDuskits = provisionalCleanCollapsed.length * CLEAN_FWA_PARTICIPATION_DUSKITS;
  repWork.verifiedEvents = seenRepKeys.size;
  repWork.provisionalEvents = seenRepKeys.size;
  repWork.strictDuskits = strictRepCandidates.length * FWA_REP_ACTION_DUSKITS;
  repWork.provisionalDuskits = provisionalRepCandidates.length * FWA_REP_ACTION_DUSKITS;
  repWork.sourceCounts = Object.fromEntries([...repSourceCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));

  return {
    scope: { guildId, from: input.scope.from.toISOString(), to: input.scope.to.toISOString(), snapshotAt: input.scope.snapshotAt.toISOString(), completeUtcWeeks: weeks },
    assumptions: {
      cleanFwaDuskits: CLEAN_FWA_PARTICIPATION_DUSKITS,
      repActionDuskits: FWA_REP_ACTION_DUSKITS,
      routineWeeklyCapDuskits: ROUTINE_WEEKLY_CAP_DUSKITS,
      personalTargetDuskits: PERSONAL_TARGET_DUSKITS,
      participationRule: "attacksUsed>0_and_attacksMissed=0",
      strictLinkRule: "VERIFIED with verifiedAt <= event time and no later PlayerLink update; current-row history sensitivity fails strict mode",
      provisionalLinkRule: "current non-revoked linked row created by event time, including historical-ownership-sensitive rows",
    },
    coverage: {
      endedWarScope: histories.length,
      warIdsWithParticipation: participationByWar.size,
      canonicalRosterComplete,
      canonicalRosterUnknown,
      completedEvaluations,
      incompleteOrMissingEvaluations,
      playerViolationRows,
      playerRowsConsidered,
      strictVerifiedLinks,
      provisionalLinks,
      missingLinks,
      lateLinks,
      revokedLinks,
      historicalOwnershipSensitiveLinks,
      duplicatePlayerIdentities,
      repEventRows: repWork.eventRows,
      recognizedFwaRepEvents: seenRepKeys.size,
      unknownRepEventRows: repWork.unknownEvents,
      duplicateRepEvents: repWork.duplicateEvents,
      correctedSourceRows,
      currentRepUsers,
      currentNonRepUsers: Math.max(0, allUsers.size - currentRepUsers),
    },
    cleanFwa,
    repWork,
    unknownReasons,
    weekly,
    targetFeasibility,
    unmodeledGaps: [
      "Blacklist triples: no historical per-attack relational owner was modeled.",
      "Base-swap acknowledgments and early swaps: mutable TrackedMessage state has no per-entry event timestamp or layout-change proof.",
      "Recurring rep stipend: TrackedClanRep has no historical assignment interval or approved threshold policy.",
      "Transfers and 14-day destination residence: no independent physical-move completion event was modeled.",
      "Giveaway fulfillment, sponsor liability, and promotional terms remain governance decisions.",
    ],
  };
}

/** Purpose: render an aggregate-only report without player/account identifiers or raw production rows. */
export function formatHistoricalDuskitsSimulationReport(report: HistoricalEarningsSimulationReport): string {
  const lines = [
    "READ ONLY — Historical Duskits earnings simulation; no rewards or writes performed.",
    `guild=${report.scope.guildId}`,
    `window=${report.scope.from}..${report.scope.to} complete_utc_weeks=${report.scope.completeUtcWeeks}`,
    `snapshot_at=${report.scope.snapshotAt}`,
    `rates_simulation_only clean_fwa=${report.assumptions.cleanFwaDuskits} rep_action=${report.assumptions.repActionDuskits} weekly_cap=${report.assumptions.routineWeeklyCapDuskits}`,
    "",
    "COVERAGE",
    ...Object.entries(report.coverage).map(([key, value]) => `${key}=${value}`),
    "",
    "CLEAN_FWA",
    ...Object.entries(report.cleanFwa).map(([key, value]) => `${key}=${value}`),
    "",
    "REP_WORK",
    ...Object.entries(report.repWork).filter(([key]) => key !== "sourceCounts").map(([key, value]) => `${key}=${value}`),
    ...Object.entries(report.repWork.sourceCounts).map(([key, value]) => `source_${key}=${value}`),
    "",
    "UNKNOWN_REASONS",
    ...Object.entries(report.unknownReasons).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`),
    "",
    "WEEKLY_DISTRIBUTION",
    ...report.weekly.flatMap((week) => [
      `week=${week.weekStart} strict_users=${week.strict.userCount} strict_uncapped=${week.strict.totalUncappedDuskits} strict_capped=${week.strict.totalCappedDuskits} strict_min=${week.strict.minUncappedDuskits} strict_median=${week.strict.medianUncappedDuskits} strict_max=${week.strict.maxUncappedDuskits}`,
      `week=${week.weekStart} provisional_users=${week.provisional.userCount} provisional_uncapped=${week.provisional.totalUncappedDuskits} provisional_capped=${week.provisional.totalCappedDuskits} provisional_min=${week.provisional.minUncappedDuskits} provisional_median=${week.provisional.medianUncappedDuskits} provisional_max=${week.provisional.maxUncappedDuskits}`,
    ]),
    "",
    "100_DUSKIT_TARGET_FEASIBILITY",
    ...Object.entries(report.targetFeasibility).map(([key, value]) => `${key}=${value}`),
    "",
    "UNMODELED_GAPS",
    ...report.unmodeledGaps.map((gap) => `- ${gap}`),
  ];
  return lines.join("\n");
}
