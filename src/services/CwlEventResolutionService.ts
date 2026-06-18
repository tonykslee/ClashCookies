import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";

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

/** Purpose: resolve or create one authoritative CWL event instance from observed league-group war tags. */
async function resolveCwlEventInTransaction(input: {
  tx: CwlEventResolutionTx;
  season: string;
  clanTag: string;
  observedWarTags: string[];
  observedAt: Date;
}): Promise<CwlEventResolutionOutcome> {
  const normalizedClanTag = normalizeClanTag(input.clanTag);
  const observedWarTags = normalizeObservedWarTags(input.observedWarTags);
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

  const previousCurrentEventClan = await input.tx.cwlEventClan.findFirst({
    where: {
      clanTag: normalizedClanTag,
      isCurrent: true,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      eventInstanceId: true,
    },
  });
  const previousCurrentEventInstanceId = previousCurrentEventClan?.eventInstanceId ?? null;

  let eventInstanceId = mappedEventIds[0] ?? null;
  let created = false;
  let anchorWarTag = observedWarTags[0];

  if (!eventInstanceId) {
    const createdEvent = await input.tx.cwlEventInstance.create({
      data: {
        season: input.season,
        anchorWarTag: buildLegacyAnchorWarTag({
          season: input.season,
          clanTag: normalizedClanTag,
        }),
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
      select: {
        id: true,
      },
    });
    eventInstanceId = createdEvent.id;
    created = true;
  } else {
    await input.tx.cwlEventInstance.update({
      where: { id: eventInstanceId },
      data: {
        lastObservedAt: input.observedAt,
      },
    });
    const event = await input.tx.cwlEventInstance.findUnique({
      where: { id: eventInstanceId },
      select: { anchorWarTag: true },
    });
    anchorWarTag = event?.anchorWarTag ?? anchorWarTag;
  }

  const existingWarTagRows = await input.tx.cwlEventWarTag.findMany({
    where: {
      eventInstanceId,
      warTag: { in: observedWarTags },
    },
    select: { warTag: true },
  });
  const existingWarTagSet = new Set(existingWarTagRows.map((row) => row.warTag));
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

  const existingCurrentClan = await input.tx.cwlEventClan.findFirst({
    where: {
      clanTag: normalizedClanTag,
      eventInstanceId,
    },
    select: {
      id: true,
      isCurrent: true,
    },
  });
  if (previousCurrentEventInstanceId && previousCurrentEventInstanceId !== eventInstanceId) {
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
  }

  if (existingCurrentClan) {
    await input.tx.cwlEventClan.update({
      where: {
        eventInstanceId_clanTag: {
          eventInstanceId,
          clanTag: normalizedClanTag,
        },
      },
      data: {
        season: input.season,
        isCurrent: true,
        lastObservedAt: input.observedAt,
      },
    });
  } else {
    await input.tx.cwlEventClan.create({
      data: {
        eventInstanceId,
        season: input.season,
        clanTag: normalizedClanTag,
        isCurrent: true,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
      },
    });
  }

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

/** Purpose: resolve the current CWL event for one clan from the authoritative current pointer. */
async function resolveCurrentCwlEventForClan(input: {
  clanTag: string;
}) {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag) return null;
  const current = await prisma.cwlEventClan.findFirst({
    where: {
      clanTag,
      isCurrent: true,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
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
  return current?.eventInstance ?? null;
}

export const cwlEventResolutionService = {
  resolveCwlEventInTransaction,
  resolveCurrentCwlEventForClan,
};
