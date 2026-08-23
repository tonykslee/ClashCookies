import { normalizeClashTagInput } from "../helper/clashTag";

export type MembershipHistoryPointIdentity = {
  guildId?: string;
  syncNumber: number;
  warId: number | null;
  clanTag: string;
  warStartTime: Date;
  opponentTag: string;
};

export type MembershipCanonicalHistoryIdentity = {
  warId: number;
  syncNumber: number | null;
  clanTag: string;
  warStartTime?: Date | null;
  opponentTag?: string | null;
};

/** Purpose: normalize a historical clan identity without guessing from names or time. */
export function normalizeMembershipHistoryClanTag(value: unknown): string {
  return normalizeClashTagInput(String(value ?? ""));
}

/** Purpose: match a canonical history only through compatible persisted identity or its exact tuple. */
export function historicalHistoryMatchesPoint(
  history: MembershipCanonicalHistoryIdentity,
  point: MembershipHistoryPointIdentity,
): boolean {
  if (history.warId === point.warId && point.warId !== null &&
    normalizeMembershipHistoryClanTag(history.clanTag) === normalizeMembershipHistoryClanTag(point.clanTag)) {
    return history.syncNumber === null || history.syncNumber === point.syncNumber;
  }
  return history.syncNumber === point.syncNumber &&
    normalizeMembershipHistoryClanTag(history.clanTag) === normalizeMembershipHistoryClanTag(point.clanTag) &&
    Boolean(history.warStartTime) &&
    history.warStartTime!.getTime() === point.warStartTime.getTime() &&
    normalizeMembershipHistoryClanTag(history.opponentTag) === normalizeMembershipHistoryClanTag(point.opponentTag);
}

/** Purpose: match a canonical history to a points row by exact semantic identity while intentionally ignoring sync number and raw war ID. */
export function historicalHistoryMatchesPointByExactTuple(
  history: MembershipCanonicalHistoryIdentity,
  point: MembershipHistoryPointIdentity,
): boolean {
  return Boolean(history.warStartTime) &&
    history.warStartTime!.getTime() === point.warStartTime.getTime() &&
    normalizeMembershipHistoryClanTag(history.clanTag) === normalizeMembershipHistoryClanTag(point.clanTag) &&
    normalizeMembershipHistoryClanTag(history.opponentTag) === normalizeMembershipHistoryClanTag(point.opponentTag);
}

/** Purpose: detect persisted same-war/same-clan sync disagreement before tuple recovery can hide it. */
export function hasMembershipHistorySyncNumberDisagreement(
  point: MembershipHistoryPointIdentity,
  histories: readonly MembershipCanonicalHistoryIdentity[],
): boolean {
  return point.warId !== null && histories.some((history) =>
    history.warId === point.warId &&
    normalizeMembershipHistoryClanTag(history.clanTag) === normalizeMembershipHistoryClanTag(point.clanTag) &&
    history.syncNumber !== null &&
    history.syncNumber !== point.syncNumber,
  );
}

/** Purpose: derive a stable owner key for a point while allowing a null raw war ID to reconcile by exact tuple. */
export function membershipHistoryPointIdentityKey(
  point: MembershipHistoryPointIdentity,
  points: readonly MembershipHistoryPointIdentity[],
): string {
  const clanTag = normalizeMembershipHistoryClanTag(point.clanTag);
  if (point.warId !== null) return `${clanTag}|war:${point.warId}`;
  const matchingNonNull = points.find((candidate) =>
    candidate.warId !== null &&
    candidate.syncNumber === point.syncNumber &&
    normalizeMembershipHistoryClanTag(candidate.clanTag) === clanTag &&
    candidate.warStartTime.getTime() === point.warStartTime.getTime() &&
    normalizeMembershipHistoryClanTag(candidate.opponentTag) === normalizeMembershipHistoryClanTag(point.opponentTag));
  return matchingNonNull
    ? `${clanTag}|war:${matchingNonNull.warId}`
    : `${clanTag}|start:${point.warStartTime.getTime()}|opponent:${normalizeMembershipHistoryClanTag(point.opponentTag)}`;
}

/** Purpose: identify incompatible persisted historical war identities within one guild/sync/clan owner. */
export function hasMembershipHistoryIdentityConflict(
  point: MembershipHistoryPointIdentity,
  points: readonly MembershipHistoryPointIdentity[],
): boolean {
  const ownerKey = `${point.guildId ?? ""}|${point.syncNumber}|${normalizeMembershipHistoryClanTag(point.clanTag)}`;
  const identities = new Set(
    points
      .filter((candidate) => `${candidate.guildId ?? ""}|${candidate.syncNumber}|${normalizeMembershipHistoryClanTag(candidate.clanTag)}` === ownerKey)
      .map((candidate) => membershipHistoryPointIdentityKey(candidate, points)),
  );
  return identities.size > 1;
}

/** Purpose: detect a null/non-null partial identity reused across distinct persisted sync owners. */
export function hasMembershipHistoryPartialIdentityConflict(
  point: MembershipHistoryPointIdentity,
  points: readonly MembershipHistoryPointIdentity[],
): boolean {
  const tuplePeers = points.filter((candidate) =>
    normalizeMembershipHistoryClanTag(candidate.clanTag) === normalizeMembershipHistoryClanTag(point.clanTag) &&
    candidate.warStartTime.getTime() === point.warStartTime.getTime() &&
    normalizeMembershipHistoryClanTag(candidate.opponentTag) === normalizeMembershipHistoryClanTag(point.opponentTag));
  if (!tuplePeers.some((candidate) => candidate.warId === null)) return false;
  return new Set(tuplePeers.map((candidate) => `${candidate.guildId ?? ""}|${candidate.syncNumber}`)).size > 1;
}

/** Purpose: key a canonical history/clan pair when checking for multiple guild/sync owners. */
export function membershipCanonicalHistoryKey(history: MembershipCanonicalHistoryIdentity): string {
  return `${history.warId}|${normalizeMembershipHistoryClanTag(history.clanTag)}`;
}

/** Purpose: return raw non-null clan/war identities claimed by more than one persisted guild/sync owner. */
export function membershipHistoryConflictingPersistedOwnerKeys(
  points: readonly MembershipHistoryPointIdentity[],
): Set<string> {
  const ownersByIdentity = new Map<string, Set<string>>();
  for (const point of points) {
    if (point.warId === null) continue;
    const identityKey = `${normalizeMembershipHistoryClanTag(point.clanTag)}|${point.warId}`;
    const owners = ownersByIdentity.get(identityKey) ?? new Set<string>();
    owners.add(`${point.guildId ?? ""}|${point.syncNumber}`);
    ownersByIdentity.set(identityKey, owners);
  }
  return new Set([...ownersByIdentity.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([identityKey]) => identityKey));
}
