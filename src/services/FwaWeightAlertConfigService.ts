import { prisma } from "../prisma";
import { normalizeTag } from "./war-events/core";

export const DEFAULT_FWA_WEIGHT_ALERT_THRESHOLD_DAYS = 7;
export const MIN_FWA_WEIGHT_ALERT_THRESHOLD_DAYS = 1;
export const MAX_FWA_WEIGHT_ALERT_THRESHOLD_DAYS = 365;

export type FwaWeightAlertConfigStatus = {
  clanTag: string;
  clanName: string | null;
  config: {
    enabled: boolean;
    thresholdDays: number;
    updatedByDiscordUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  leaderChannelId: string | null;
  leadRoleId: string | null;
  routingReady: boolean;
};

export type FwaWeightAlertMutation = {
  thresholdDays?: number;
  enabled?: boolean;
};

function canonicalTag(input: string): string {
  const normalized = normalizeTag(input ?? "");
  return normalized;
}

function validateThresholdDays(thresholdDays: number | undefined): void {
  if (thresholdDays === undefined) return;
  if (
    !Number.isInteger(thresholdDays) ||
    thresholdDays < MIN_FWA_WEIGHT_ALERT_THRESHOLD_DAYS ||
    thresholdDays > MAX_FWA_WEIGHT_ALERT_THRESHOLD_DAYS
  ) {
    throw new Error(
      `after-days must be an integer from ${MIN_FWA_WEIGHT_ALERT_THRESHOLD_DAYS} to ${MAX_FWA_WEIGHT_ALERT_THRESHOLD_DAYS}.`,
    );
  }
}

/** Purpose: persist and inspect per-clan weight-alert configuration without delivering alerts. */
export class FwaWeightAlertConfigService {
  private async findTrackedClan(inputTag: string) {
    const tag = canonicalTag(inputTag);
    if (!tag) return null;
    return prisma.trackedClan.findFirst({
      where: {
        OR: [
          { tag: { equals: tag, mode: "insensitive" } },
          { tag: { equals: tag.slice(1), mode: "insensitive" } },
        ],
      },
      select: {
        tag: true,
        name: true,
        leaderChannelId: true,
        leadRoleId: true,
      },
    });
  }

  async getStatus(inputTag: string): Promise<FwaWeightAlertConfigStatus | null> {
    const trackedClan = await this.findTrackedClan(inputTag);
    if (!trackedClan) return null;

    const config = await prisma.fwaWeightAlertConfig.findUnique({
      where: { clanTag: trackedClan.tag },
      select: {
        enabled: true,
        thresholdDays: true,
        updatedByDiscordUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      clanTag: canonicalTag(trackedClan.tag),
      clanName: trackedClan.name,
      config,
      leaderChannelId: trackedClan.leaderChannelId,
      leadRoleId: trackedClan.leadRoleId,
      routingReady: Boolean(trackedClan.leaderChannelId && trackedClan.leadRoleId),
    };
  }

  async update(
    inputTag: string,
    updatedByDiscordUserId: string,
    mutation: FwaWeightAlertMutation,
  ): Promise<FwaWeightAlertConfigStatus> {
    validateThresholdDays(mutation.thresholdDays);
    if (mutation.thresholdDays === undefined && mutation.enabled === undefined) {
      throw new Error("Provide `after-days` or `enabled` to change the configuration.");
    }

    const trackedClan = await this.findTrackedClan(inputTag);
    if (!trackedClan) {
      throw new Error(`Clan ${inputTag} is not in tracked clans.`);
    }

    const current = await prisma.fwaWeightAlertConfig.findUnique({
      where: { clanTag: trackedClan.tag },
      select: { thresholdDays: true, enabled: true },
    });
    const thresholdDays =
      mutation.thresholdDays ??
      current?.thresholdDays ??
      DEFAULT_FWA_WEIGHT_ALERT_THRESHOLD_DAYS;
    const enabled =
      mutation.enabled ??
      (mutation.thresholdDays !== undefined ? true : current?.enabled ?? false);

    await prisma.fwaWeightAlertConfig.upsert({
      where: { clanTag: trackedClan.tag },
      create: {
        clanTag: trackedClan.tag,
        enabled,
        thresholdDays,
        updatedByDiscordUserId,
      },
      update: {
        enabled,
        thresholdDays,
        updatedByDiscordUserId,
      },
    });

    const status = await this.getStatus(trackedClan.tag);
    if (!status) {
      throw new Error(`Clan ${inputTag} is not in tracked clans.`);
    }
    return status;
  }
}

export const fwaWeightAlertConfigService = new FwaWeightAlertConfigService();
