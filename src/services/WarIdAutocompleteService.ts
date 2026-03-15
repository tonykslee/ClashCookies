import { prisma } from "../prisma";

type WarAutocompleteCandidate = {
  warId: number;
  opponentName: string | null;
  endedAt: Date | null;
};

type WarAutocompleteChoice = {
  name: string;
  value: string;
};

const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_RESULT_LIMIT = 10;
const DEFAULT_TIME_ZONE = "UTC";

function normalizeTagBare(input: string | null | undefined): string {
  return String(input ?? "").trim().toUpperCase().replace(/^#/, "");
}

function parseDateLike(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseLookupPayload(payload: unknown): {
  endedAt: Date | null;
  opponentName: string | null;
} {
  let parsed: unknown = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }

  const root = asRecord(parsed);
  if (!root) return { endedAt: null, opponentName: null };

  const warMeta = asRecord(root.warMeta);
  const opponent = asRecord(root.opponent);
  return {
    endedAt: parseDateLike(warMeta?.endTime ?? root.endTime ?? null),
    opponentName: String(opponent?.name ?? "").trim() || null,
  };
}

function compareCandidates(left: WarAutocompleteCandidate, right: WarAutocompleteCandidate): number {
  const leftTime = left.endedAt instanceof Date ? left.endedAt.getTime() : Number.NEGATIVE_INFINITY;
  const rightTime =
    right.endedAt instanceof Date ? right.endedAt.getTime() : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.warId - left.warId;
}

function buildLabel(input: {
  warId: number;
  endedAt: Date | null;
  opponentName: string | null;
  timeZone: string;
}): string {
  const ended = input.endedAt instanceof Date
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        month: "2-digit",
        day: "2-digit",
      }).format(input.endedAt)
    : "??/??";
  const opponent = input.opponentName ?? "Unknown Opponent";
  return `${input.warId} | ended: ${ended} | ${opponent}`.slice(0, 100);
}

/** Purpose: build deterministic clan-scoped historical war-id autocomplete choices shared by /fwa compliance and /war. */
export async function getClanScopedWarIdAutocompleteChoices(input: {
  rawClanTag: string | null | undefined;
  focusedText: string | null | undefined;
  timeZone?: string;
  candidateLimit?: number;
  resultLimit?: number;
}): Promise<WarAutocompleteChoice[]> {
  const bareTag = normalizeTagBare(input.rawClanTag);
  if (!bareTag) return [];

  const trackedClan = await prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: `#${bareTag}`, mode: "insensitive" } },
        { tag: { equals: bareTag, mode: "insensitive" } },
      ],
    },
    select: { tag: true },
  });
  if (!trackedClan) return [];

  const trackedBareTag = normalizeTagBare(trackedClan.tag);
  if (!trackedBareTag) return [];
  const clanTagValues = [...new Set([`#${trackedBareTag}`, trackedBareTag])];
  const candidateLimit = Math.max(1, Math.trunc(Number(input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT)));
  const resultLimit = Math.max(1, Math.trunc(Number(input.resultLimit ?? DEFAULT_RESULT_LIMIT)));
  const timeZone = String(input.timeZone ?? DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;

  const [historyRows, lookupRows] = await Promise.all([
    prisma.clanWarHistory.findMany({
      where: {
        OR: clanTagValues.map((value) => ({ clanTag: value })),
      },
      orderBy: [{ warEndTime: "desc" }, { warId: "desc" }],
      take: candidateLimit,
      select: {
        warId: true,
        warEndTime: true,
        opponentName: true,
      },
    }),
    prisma.warLookup.findMany({
      where: {
        OR: clanTagValues.map((value) => ({ clanTag: { equals: value, mode: "insensitive" } })),
      },
      orderBy: [{ endTime: "desc" }, { startTime: "desc" }],
      take: candidateLimit,
      select: {
        warId: true,
        endTime: true,
        payload: true,
      },
    }),
  ]);

  const byWarId = new Map<number, WarAutocompleteCandidate>();
  for (const row of historyRows) {
    const warId = Number(row.warId);
    if (!Number.isFinite(warId) || Math.trunc(warId) <= 0) continue;
    byWarId.set(Math.trunc(warId), {
      warId: Math.trunc(warId),
      opponentName: String(row.opponentName ?? "").trim() || null,
      endedAt: row.warEndTime instanceof Date ? row.warEndTime : null,
    });
  }

  for (const row of lookupRows) {
    const warId = Number(row.warId);
    if (!Number.isFinite(warId) || Math.trunc(warId) <= 0) continue;
    const normalizedWarId = Math.trunc(warId);
    const parsedPayload = parseLookupPayload(row.payload);
    const endedAt = (row.endTime instanceof Date ? row.endTime : null) ?? parsedPayload.endedAt ?? null;
    const existing = byWarId.get(normalizedWarId);
    if (!existing && !(endedAt instanceof Date)) {
      // Lookup-only rows without ended time are not eligible for ended-war suggestions.
      continue;
    }

    const next: WarAutocompleteCandidate = existing ?? {
      warId: normalizedWarId,
      opponentName: null,
      endedAt: null,
    };
    if (!(next.endedAt instanceof Date) && endedAt instanceof Date) {
      next.endedAt = endedAt;
    }
    if (!next.opponentName) {
      next.opponentName = parsedPayload.opponentName;
    }
    byWarId.set(normalizedWarId, next);
  }

  const query = String(input.focusedText ?? "").trim().toLowerCase();
  return [...byWarId.values()]
    .sort(compareCandidates)
    .map((candidate) => ({
      name: buildLabel({
        warId: candidate.warId,
        endedAt: candidate.endedAt,
        opponentName: candidate.opponentName,
        timeZone,
      }),
      value: String(candidate.warId),
      opponentName: candidate.opponentName ?? "Unknown Opponent",
    }))
    .filter((candidate) => {
      if (!query) return true;
      return (
        candidate.value.toLowerCase().includes(query) ||
        candidate.opponentName.toLowerCase().includes(query) ||
        candidate.name.toLowerCase().includes(query)
      );
    })
    .slice(0, resultLimit)
    .map((candidate) => ({ name: candidate.name, value: candidate.value }));
}
