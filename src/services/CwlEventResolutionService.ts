import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";

export type CwlCurrentEventSummary = {
  id: string;
  season: string;
  anchorWarTag: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

export type CwlEventResolutionOutcome =
  | {
      kind: "resolved";
      eventInstanceId: string;
      season: string;
      anchorWarTag: string;
      previousCurrentEventInstanceId: string | null;
      created: boolean;
      attachedWarTags: string[];
      observedWarTagCount: number;
    }
  | {
      kind: "unresolved";
      reason: "NO_VALID_WAR_TAG" | "NO_CURRENT_EVENT_FOR_CLAN" | "UNKNOWN";
      observedWarTagCount: number;
    }
  | {
      kind: "collision";
      reason: "WAR_TAG_EVENT_COLLISION";
      observedWarTagCount: number;
      conflictingEventInstanceIds: string[];
    };

type CwlEventResolutionTx = Pick<
  Prisma.TransactionClient,
  "cwlEventClan" | "cwlEventInstance" | "cwlEventWarTag"
>;

const CWL_EVENT_RESOLUTION_RETRY_LIMIT = 3;

function normalizeObservedWarTags(warTags: string[]): string[] {
  return [
    ...new Set(
      warTags
        .map((warTag) => normalizeClanTag(String(warTag ?? "")))
        .filter((warTag): warTag is string => Boolean(warTag && warTag !== "#0")),
    ),
  ];
}

function buildLegacyAnchorWarTag(input: {
  season: string;
  clanTag: string;
}): string {
  return `legacy:${input.season}:${input.clanTag}`;
}

function isRetryableCwlEventResolutionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "P2002" || code === "P2034";
}

function compareCurrentEventSummaries(
  a: CwlCurrentEventSummary,
  b: CwlCurrentEventSummary,
): number {
  const byLastObservedAt = b.lastObservedAt.getTime() - a.lastObservedAt.getTime();
  if (byLastObservedAt !== 0) return byLastObservedAt;
  const byFirstObservedAt = b.firstObservedAt.getTime() - a.firstObservedAt.getTime();
  if (byFirstObservedAt !== 0) return byFirstObservedAt;
  return b.id.localeCompare(a.id);
}

async function resolveCurrentCwlEventSummariesForClanTags(input: {
  clanTags: string[];
  season?: string | null;
}): Promise<Map<string, CwlCurrentEventSummary>> {
  const clanTags = [
    ...new Set(
      input.clanTags
        .map((clanTag) => normalizeClanTag(String(clanTag ?? "")))
        .filter((clanTag): clanTag is string => Boolean(clanTag)),
    ),
  ];
  if (clanTags.length <= 0) return new Map();

  const requestedSeason = String(input.season ?? "").trim() || null;

  const rows = await prisma.cwlEventClan.findMany({
    where: {
      clanTag: { in: clanTags },
      isCurrent: true,
      ...(requestedSeason ? { season: requestedSeason } : {}),
    },
    select: {
      clanTag: true,
      eventInstance: {
        select: {
          id: true,
          season: true,
          anchorWarTag: true,
          firstObservedAt: true,
          lastObservedAt: true,
        },
      },
    },
  });

  const result = new Map<string, CwlCurrentEventSummary>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const event = row.eventInstance;
    if (!clanTag || !event) continue;
    if (requestedSeason && event.season !== requestedSeason) continue;
    const next = {
      id: event.id,
      season: event.season,
      anchorWarTag: event.anchorWarTag,
      firstObservedAt: event.firstObservedAt,
      lastObservedAt: event.lastObservedAt,
    };
    const existing = result.get(clanTag);
    if (!existing || compareCurrentEventSummaries(next, existing) < 0) {
      result.set(clanTag, next);
    }
  }

  return result;
}

async function resolveCwlEventInTransaction(input: {
  tx: CwlEventResolutionTx;
  season: string;
  clanTag: string;
  observedWarTags: string[];
  observedAt: Date;
}): Promise<CwlEventResolutionOutcome> {
  const normalizedClanTag = normalizeClanTag(input.clanTag);
  const observedWarTags = [
    ...new Set(
      normalizeObservedWarTags(input.observedWarTags).sort((a, b) => a.localeCompare(b)),
    ),
  ];
  if (observedWarTags.length <= 0) {
    console.warn(
      [
        "[cwl-event] event=event_resolution_unresolved",
        `season=${input.season}`,
        `clan_tag=${normalizedClanTag}`,
        "reason=NO_VALID_WAR_TAG",
        "observed_war_tag_count=0",
      ].join(" "),
    );
    return {
      kind: "unresolved",
      reason: "NO_VALID_WAR_TAG",
      observedWarTagCount: 0,
    };
  }

  const mappedWarTags = await input.tx.cwlEventWarTag.findMany({
    where: { warTag: { in: observedWarTags } },
    select: {
      warTag: true,
      eventInstanceId: true,
    },
  });
  const mappedEventIds = [...new Set(mappedWarTags.map((row) => row.eventInstanceId))];
  if (mappedEventIds.length > 1) {
    console.warn(
      [
        "[cwl-event] event=event_resolution_collision",
        `season=${input.season}`,
        `clan_tag=${normalizedClanTag}`,
        `observed_war_tag_count=${observedWarTags.length}`,
        `conflicting_event_ids=${mappedEventIds.join(",")}`,
      ].join(" "),
    );
    return {
      kind: "collision",
      reason: "WAR_TAG_EVENT_COLLISION",
      observedWarTagCount: observedWarTags.length,
      conflictingEventInstanceIds: mappedEventIds,
    };
  }

  const currentClanRows = await input.tx.cwlEventClan.findMany({
    where: {
      clanTag: normalizedClanTag,
      isCurrent: true,
    },
    select: {
      eventInstanceId: true,
      eventInstance: {
        select: {
          id: true,
          season: true,
          anchorWarTag: true,
          firstObservedAt: true,
          lastObservedAt: true,
        },
      },
    },
  });
  let previousCurrentEventInstanceId: string | null = null;
  let previousCurrentSummary: CwlCurrentEventSummary | null = null;
  for (const row of currentClanRows) {
    const event = row.eventInstance;
    if (!event) continue;
    const nextSummary: CwlCurrentEventSummary = {
      id: event.id,
      season: event.season,
      anchorWarTag: event.anchorWarTag,
      firstObservedAt: event.firstObservedAt,
      lastObservedAt: event.lastObservedAt,
    };
    if (!previousCurrentSummary || compareCurrentEventSummaries(nextSummary, previousCurrentSummary) < 0) {
      previousCurrentSummary = nextSummary;
      previousCurrentEventInstanceId = event.id;
    }
  }

  let eventInstanceId = mappedEventIds[0] ?? null;
  let created = false;
  let anchorWarTag = observedWarTags[0];

  if (!eventInstanceId) {
    const createdEvent = await input.tx.cwlEventInstance.create({
      data: {
        season: input.season,
        anchorWarTag,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
      select: {
        id: true,
        anchorWarTag: true,
      },
    });
    eventInstanceId = createdEvent.id;
    anchorWarTag = createdEvent.anchorWarTag;
    created = true;
  } else {
    await input.tx.cwlEventInstance.update({
      where: { id: eventInstanceId },
      data: {
        lastObservedAt: input.observedAt,
      },
    });
    const existingEvent = await input.tx.cwlEventInstance.findUnique({
      where: { id: eventInstanceId },
      select: { anchorWarTag: true },
    });
    anchorWarTag = existingEvent?.anchorWarTag ?? anchorWarTag;
  }

  await input.tx.cwlEventWarTag.updateMany({
    where: {
      eventInstanceId,
      warTag: { in: observedWarTags },
    },
    data: {
      lastObservedAt: input.observedAt,
    },
  });
  const existingWarTags = await input.tx.cwlEventWarTag.findMany({
    where: {
      eventInstanceId,
      warTag: { in: observedWarTags },
    },
    select: { warTag: true },
  });
  const existingWarTagSet = new Set(existingWarTags.map((row) => row.warTag));
  const attachedWarTags: string[] = [];
  for (const warTag of observedWarTags) {
    if (existingWarTagSet.has(warTag)) continue;
    attachedWarTags.push(warTag);
    await input.tx.cwlEventWarTag.create({
      data: {
        eventInstanceId,
        season: input.season,
        warTag,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
    });
  }
  if (attachedWarTags.length > 0) {
    console.info(
      [
        "[cwl-event] event=event_war_tags_attached",
        `season=${input.season}`,
        `clan_tag=${normalizedClanTag}`,
        `event_instance_id=${eventInstanceId}`,
        `anchor_war_tag=${anchorWarTag}`,
        `observed_war_tag_count=${observedWarTags.length}`,
        `attached_war_tags=${attachedWarTags.join(",")}`,
      ].join(" "),
    );
  }

  await input.tx.cwlEventClan.updateMany({
    where: {
      clanTag: normalizedClanTag,
      isCurrent: true,
      eventInstanceId: {
        not: eventInstanceId,
      },
    },
    data: {
      isCurrent: false,
    },
  });

  await input.tx.cwlEventClan.upsert({
    where: {
      eventInstanceId_clanTag: {
        eventInstanceId,
        clanTag: normalizedClanTag,
      },
    },
    create: {
      eventInstanceId,
      season: input.season,
      clanTag: normalizedClanTag,
      isCurrent: true,
      firstObservedAt: input.observedAt,
      lastObservedAt: input.observedAt,
    },
    update: {
      season: input.season,
      isCurrent: true,
      lastObservedAt: input.observedAt,
    },
  });

  if (previousCurrentEventInstanceId !== eventInstanceId) {
    console.info(
      [
        "[cwl-event] event=clan_current_event_changed",
        `season=${input.season}`,
        `clan_tag=${normalizedClanTag}`,
        `event_instance_id=${eventInstanceId}`,
        `previous_current_event_instance_id=${previousCurrentEventInstanceId ?? "none"}`,
        `anchor_war_tag=${anchorWarTag}`,
      ].join(" "),
    );
  }

  return {
    kind: "resolved",
    eventInstanceId: eventInstanceId!,
    season: input.season,
    anchorWarTag,
    previousCurrentEventInstanceId,
    created,
    attachedWarTags,
    observedWarTagCount: observedWarTags.length,
  };
}

/** Purpose: resolve or create one authoritative CWL event instance from observed league-group war tags. */
async function resolveCwlEventForClan(input: {
  season: string;
  clanTag: string;
  observedWarTags: string[];
  observedAt: Date;
}): Promise<CwlEventResolutionOutcome> {
  for (let attempt = 1; attempt <= CWL_EVENT_RESOLUTION_RETRY_LIMIT; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) =>
        resolveCwlEventInTransaction({
          tx: tx as CwlEventResolutionTx,
          season: input.season,
          clanTag: input.clanTag,
          observedWarTags: input.observedWarTags,
          observedAt: input.observedAt,
        }),
      );
    } catch (error) {
      if (!isRetryableCwlEventResolutionError(error) || attempt >= CWL_EVENT_RESOLUTION_RETRY_LIMIT) {
        throw error;
      }
      console.warn(
        [
          "[cwl-event] event=event_resolution_retry",
          `season=${input.season}`,
          `clan_tag=${normalizeClanTag(input.clanTag)}`,
          `attempt=${attempt}`,
          `retry_limit=${CWL_EVENT_RESOLUTION_RETRY_LIMIT}`,
          `reason=${String((error as { code?: unknown }).code ?? "unknown")}`,
        ].join(" "),
      );
    }
  }

  throw new Error("Unreachable CWL event resolution retry exit.");
}

/** Purpose: resolve the current CWL event for one clan from the authoritative current pointer. */
async function resolveCurrentCwlEventForClan(input: {
  clanTag: string;
}) {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag) return null;
  const currentEvents = await resolveCurrentCwlEventSummariesForClanTags({
    clanTags: [clanTag],
  });
  return currentEvents.get(clanTag) ?? null;
}

export const cwlEventResolutionService = {
  resolveCwlEventForClan,
  resolveCwlEventInTransaction,
  resolveCurrentCwlEventForClan,
  resolveCurrentCwlEventSummariesForClanTags,
};
