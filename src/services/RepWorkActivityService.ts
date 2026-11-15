import { Prisma, RepWorkActivityType } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { normalizeDiscordUserId } from "./PlayerLinkService";

type RepWorkActivityMetadata = Record<string, unknown>;

const REP_WORK_AUDIT_EVENT_SELECT = {
  id: true,
  guildId: true,
  activityType: true,
  discordUserId: true,
  clanTag: true,
  syncMessageId: true,
  sourceMessageId: true,
  sourceTrackedMessageId: true,
  warId: true,
  warStartTime: true,
  opponentTag: true,
  eventAt: true,
  metadata: true,
  dedupeKey: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RepWorkActivityEventSelect;

export type RepWorkActivityAuditEvent = Prisma.RepWorkActivityEventGetPayload<{
  select: typeof REP_WORK_AUDIT_EVENT_SELECT;
}>;

export type RepWorkActivityEvaluationRead = {
  guildId: string;
  from: Date;
  to: Date;
  limit: number;
};

const MAX_EVALUATION_READ_EVENTS = 10_000;

function normalizeTextId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed || null;
}

function normalizeClanTagText(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return trimmed ? `#${trimmed}` : null;
}

function normalizeWarIdText(input: string | number | null | undefined): string | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return String(Math.trunc(input));
  }
  const text = String(input ?? "").trim();
  return text || null;
}

function normalizeDate(input: Date | null | undefined): Date | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input : null;
}

function computePrepTimeLeftSeconds(params: {
  eventAt: Date;
  warStartTime?: Date | null;
}): number | null {
  const warStartTime = normalizeDate(params.warStartTime ?? null);
  if (!warStartTime) return null;
  return Math.max(0, Math.trunc((warStartTime.getTime() - params.eventAt.getTime()) / 1000));
}

function buildDedupeKey(params: {
  activityType: RepWorkActivityType;
  guildId: string;
  discordUserId: string;
  clanTag: string;
  syncMessageId: string | null;
  sourceMessageId: string;
}): string {
  const syncScope = params.syncMessageId
    ? `sync:${params.syncMessageId}`
    : `source:${params.sourceMessageId}`;
  return [
    "rep-work",
    params.activityType,
    `guild=${params.guildId}`,
    `user=${params.discordUserId}`,
    `clan=${params.clanTag}`,
    syncScope,
  ].join("|");
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "code" in err &&
      String((err as { code?: string }).code ?? "") === "P2002",
  );
}

function buildEventMetadata(input: {
  activityType: RepWorkActivityType;
  source: string;
  syncMessageId: string | null;
  sourceMessageId: string;
  sourceTrackedMessageId: string | null;
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string | null;
  eventAt: Date;
  prepTimeLeftSeconds: number | null;
  extra?: RepWorkActivityMetadata | null;
}): Prisma.InputJsonValue {
  return {
    ...(input.extra ?? {}),
    activityType: input.activityType,
    source: input.source,
    syncMessageId: input.syncMessageId,
    sourceMessageId: input.sourceMessageId,
    sourceTrackedMessageId: input.sourceTrackedMessageId,
    warId: input.warId,
    warStartTimeIso: input.warStartTime?.toISOString() ?? null,
    opponentTag: input.opponentTag,
    eventAtIso: input.eventAt.toISOString(),
    prepTimeLeftSeconds: input.prepTimeLeftSeconds,
  };
}

export type RepWorkRecordInput = {
  guildId: string;
  discordUserId: string;
  clanTag: string;
  syncMessageId?: string | null;
  sourceMessageId: string;
  sourceTrackedMessageId?: string | null;
  warId?: string | number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
  eventAt?: Date | null;
  prepTimeLeftSeconds?: number | null;
  metadata?: RepWorkActivityMetadata | null;
};

export class RepWorkActivityService {
  /** Purpose: expose one persisted rep-work event to bounded audit consumers without transferring ownership. */
  async findEventForAudit(eventId: string): Promise<RepWorkActivityAuditEvent | null> {
    const normalizedEventId = normalizeTextId(eventId);
    if (!normalizedEventId) return null;
    return prisma.repWorkActivityEvent.findUnique({
      where: { id: normalizedEventId },
      select: REP_WORK_AUDIT_EVENT_SELECT,
    });
  }

  /** Purpose: read one bounded, chronologically stable rep-work evidence window without writes or side effects. */
  async listEventsForEvaluation(input: RepWorkActivityEvaluationRead): Promise<RepWorkActivityAuditEvent[]> {
    const guildId = String(input.guildId ?? "").trim();
    const limit = Number(input.limit);
    if (!guildId || !(input.from instanceof Date) || !Number.isFinite(input.from.getTime()) || !(input.to instanceof Date) || !Number.isFinite(input.to.getTime()) || input.to <= input.from) {
      throw new Error("A valid guild and half-open evaluation window are required.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVALUATION_READ_EVENTS) {
      throw new Error(`Evaluation event limit must be an integer between 1 and ${MAX_EVALUATION_READ_EVENTS}.`);
    }
    const rows = await prisma.repWorkActivityEvent.findMany({
      where: { guildId, eventAt: { gte: input.from, lt: input.to } },
      orderBy: [{ eventAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: REP_WORK_AUDIT_EVENT_SELECT,
    });
    if (rows.length > limit) {
      throw new Error("Rep-work evaluation scope exceeds its bounded event limit.");
    }
    return rows;
  }

  async recordBasesChecked(params: RepWorkRecordInput): Promise<boolean> {
    return this.recordActivity(RepWorkActivityType.BASES_CHECKED, "base_swap", params);
  }

  async recordBasesChecklistChecked(params: RepWorkRecordInput): Promise<boolean> {
    return this.recordActivity(RepWorkActivityType.BASES_CHECKED, "bases_checklist", params);
  }

  async recordMailChecked(params: RepWorkRecordInput): Promise<boolean> {
    return this.recordActivity(RepWorkActivityType.MAIL_CHECKED, "mail_checklist", params);
  }

  async recordMailSent(params: RepWorkRecordInput): Promise<boolean> {
    return this.recordActivity(RepWorkActivityType.MAIL_SENT, "fwa_match_mail_send", params);
  }

  private async recordActivity(
    activityType: RepWorkActivityType,
    source: string,
    params: RepWorkRecordInput,
  ): Promise<boolean> {
    const guildId = String(params.guildId ?? "").trim();
    const discordUserId = normalizeDiscordUserId(params.discordUserId);
    const clanTag = normalizeClanTagText(params.clanTag);
    const syncMessageId = normalizeTextId(params.syncMessageId ?? null);
    const sourceMessageId = normalizeTextId(params.sourceMessageId);
    const sourceTrackedMessageId = normalizeTextId(params.sourceTrackedMessageId ?? null);
    const warId = normalizeWarIdText(params.warId ?? null);
    const warStartTime = normalizeDate(params.warStartTime ?? null);
    const opponentTag = normalizeClanTagText(params.opponentTag ?? "");
    const eventAt = normalizeDate(params.eventAt ?? null) ?? new Date();

    if (!guildId || !discordUserId || !clanTag || !sourceMessageId) {
      return false;
    }

    const dedupeKey = buildDedupeKey({
      activityType,
      guildId,
      discordUserId,
      clanTag,
      syncMessageId,
      sourceMessageId,
    });
    const explicitPrepTimeLeftSeconds =
      params.prepTimeLeftSeconds !== undefined &&
      params.prepTimeLeftSeconds !== null &&
      Number.isFinite(Number(params.prepTimeLeftSeconds))
        ? Math.max(0, Math.trunc(Number(params.prepTimeLeftSeconds)))
        : null;
    const prepTimeLeftSeconds =
      explicitPrepTimeLeftSeconds ?? computePrepTimeLeftSeconds({ eventAt, warStartTime });

    try {
      await prisma.repWorkActivityEvent.create({
        data: {
          guildId,
          activityType,
          discordUserId,
          clanTag,
          syncMessageId,
          sourceMessageId,
          sourceTrackedMessageId,
          warId,
          warStartTime,
          opponentTag: opponentTag || null,
          eventAt,
          prepTimeLeftSeconds,
          metadata: buildEventMetadata({
            activityType,
            source,
            syncMessageId,
            sourceMessageId,
            sourceTrackedMessageId,
            warId,
            warStartTime,
            opponentTag: opponentTag || null,
            eventAt,
            prepTimeLeftSeconds,
            extra: params.metadata ?? null,
          }),
          dedupeKey,
        },
      });
      return true;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return true;
      }
      console.error(
        `[rep-work-activity] record_failed activityType=${activityType} guild=${guildId} user=${discordUserId} clan=${clanTag} error=${formatError(err)}`,
      );
      return false;
    }
  }
}

export const repWorkActivityService = new RepWorkActivityService();
