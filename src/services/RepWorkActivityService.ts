import { Prisma, RepWorkActivityType } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { normalizeDiscordUserId } from "./PlayerLinkService";

type RepWorkActivityMetadata = Record<string, unknown>;

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
