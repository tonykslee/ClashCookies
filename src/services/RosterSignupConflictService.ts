import { prisma } from "../prisma";
import { normalizePlayerTag } from "./PlayerLinkService";

const ROSTER_SIGNUP_CONFLICT_ROSTER_TYPE = "CWL";
const ROSTER_SIGNUP_CONFLICT_LIFECYCLE_STATES = ["ACTIVE", "OPEN"] as const;

export type RosterSignupConflictRecord = {
  playerTag: string;
  conflictingRosterId: string;
  conflictingRosterTitle: string;
};

function normalizeRosterSignupConflictTitle(input: string | null | undefined): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadCwlRosterSignupConflictLookup(input: {
  guildId: string;
  currentRosterId: string;
  playerTags: string[];
}): Promise<Map<string, RosterSignupConflictRecord>> {
  const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  if (normalizedTags.length <= 0) {
    return new Map();
  }

  const candidateRosters = await prisma.roster.findMany({
    where: {
      guildId: input.guildId,
      rosterType: ROSTER_SIGNUP_CONFLICT_ROSTER_TYPE,
      lifecycleState: { in: [...ROSTER_SIGNUP_CONFLICT_LIFECYCLE_STATES] },
      id: { not: input.currentRosterId },
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      createdAt: true,
    },
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }, { title: "asc" }, { id: "asc" }],
  });
  if (candidateRosters.length <= 0) {
    return new Map();
  }

  const candidateRosterIds = candidateRosters.map((roster) => roster.id);
  const rosterById = new Map(candidateRosters.map((roster) => [roster.id, roster] as const));
  const rosterOrderById = new Map(candidateRosters.map((roster, index) => [roster.id, index] as const));

  const conflictRows = await prisma.rosterSignup.findMany({
    where: {
      playerTag: { in: normalizedTags },
      rosterId: { in: candidateRosterIds },
    },
    select: {
      playerTag: true,
      rosterId: true,
    },
  });

  const bestByTag = new Map<string, RosterSignupConflictRecord & { rosterOrder: number }>();
  for (const row of conflictRows) {
    const normalizedTag = normalizePlayerTag(row.playerTag);
    if (!normalizedTag) {
      continue;
    }
    const roster = rosterById.get(row.rosterId);
    if (!roster) {
      continue;
    }
    const rosterOrder = rosterOrderById.get(roster.id) ?? Number.MAX_SAFE_INTEGER;
    const existing = bestByTag.get(normalizedTag);
    if (existing && existing.rosterOrder <= rosterOrder) {
      continue;
    }
    bestByTag.set(normalizedTag, {
      playerTag: normalizedTag,
      conflictingRosterId: roster.id,
      conflictingRosterTitle: normalizeRosterSignupConflictTitle(roster.title),
      rosterOrder,
    });
  }

  return new Map(
    [...bestByTag.entries()].map(([playerTag, record]) => [
      playerTag,
      {
        playerTag: record.playerTag,
        conflictingRosterId: record.conflictingRosterId,
        conflictingRosterTitle: record.conflictingRosterTitle,
      },
    ]),
  );
}
