import { type Client } from "discord.js";
import { randomUUID } from "node:crypto";
import { dozzleLog } from "../helper/dozzleLogger";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildFwaWeightPageUrl,
  deriveFwaCatalogWeightAge,
} from "./FwaWeightCatalogService";
import { isMirrorPollingMode } from "./PollingModeService";
import { normalizeTag } from "./war-events/core";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_FAILURE_REASON_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 2_000;

type WeightAlertConfigRow = {
  clanTag: string;
  thresholdDays: number;
};

type WeightAlertCatalogRow = {
  clanTag: string;
  name: string | null;
  weightSubmitDate: Date | null;
};

type WeightAlertTrackedClanRow = {
  tag: string;
  name: string | null;
  leaderChannelId: string | null;
  leadRoleId: string | null;
};

type WeightAlertDeliveryRow = {
  id: string;
  status: "CLAIMED" | "SENT" | "FAILED";
  claimToken: string | null;
  claimedAt: Date | null;
  attemptCount: number;
};

type FwaWeightAlertDeliveryDb = {
  fwaWeightAlertConfig: {
    findMany: (args?: unknown) => Promise<WeightAlertConfigRow[]>;
  };
  fwaClanCatalog: {
    findMany: (args?: unknown) => Promise<WeightAlertCatalogRow[]>;
  };
  trackedClan: {
    findMany: (args?: unknown) => Promise<WeightAlertTrackedClanRow[]>;
  };
  fwaWeightAlertDelivery: {
    findUnique: (args?: unknown) => Promise<WeightAlertDeliveryRow | null>;
    create: (args: unknown) => Promise<WeightAlertDeliveryRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  $transaction: <T>(callback: (tx: FwaWeightAlertDeliveryDb) => Promise<T>) => Promise<T>;
};

type SendableTextChannel = {
  isTextBased?: () => boolean;
  send?: (payload: {
    content: string;
    allowedMentions: { parse: []; roles: string[] };
  }) => Promise<{ id?: string | null }>;
};

export type FwaWeightAlertDeliveryClient = Pick<Client, "channels">;

export type FwaWeightAlertDeliveryCounts = {
  evaluatedConfigCount: number;
  eligibleCount: number;
  claimedCount: number;
  retryCount: number;
  sentCount: number;
  failedCount: number;
  alreadySentCount: number;
  claimedRecentlyCount: number;
  notDueCount: number;
  missingDateCount: number;
  invalidDateCount: number;
  missingRoutingCount: number;
  skippedCount: number;
};

export type FwaWeightAlertDeliveryResult = {
  counts: FwaWeightAlertDeliveryCounts;
  durationMs: number;
  skippedReason?: "mirror_or_staging";
};

type FwaWeightAlertDeliveryDependencies = {
  db?: FwaWeightAlertDeliveryDb;
  clock?: () => Date;
  randomUUID?: () => string;
  staleClaimMs?: number;
};

type ClaimResult =
  | { kind: "claimed"; id: string; claimToken: string; retry: boolean }
  | { kind: "already_sent" }
  | { kind: "claimed_recently" }
  | { kind: "contended" };

function emptyCounts(): FwaWeightAlertDeliveryCounts {
  return {
    evaluatedConfigCount: 0,
    eligibleCount: 0,
    claimedCount: 0,
    retryCount: 0,
    sentCount: 0,
    failedCount: 0,
    alreadySentCount: 0,
    claimedRecentlyCount: 0,
    notDueCount: 0,
    missingDateCount: 0,
    invalidDateCount: 0,
    missingRoutingCount: 0,
    skippedCount: 0,
  };
}

function canonicalTag(input: string): string {
  return normalizeTag(input ?? "").replace(/^#/, "").toUpperCase();
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "") === "P2002";
}

function boundedFailureReason(error: unknown): string {
  return formatError(error).slice(0, MAX_FAILURE_REASON_LENGTH);
}

function failureCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null | undefined)?.code ?? "").trim();
  return (code || "DELIVERY_FAILED").slice(0, 100);
}

function buildAlertMessage(input: {
  clanTag: string;
  clanName: string | null;
  weightSubmitDate: Date;
  thresholdDays: number;
  now: Date;
  leadRoleId: string;
}): string {
  const age = deriveFwaCatalogWeightAge(input.clanTag, input.weightSubmitDate, input.now);
  const displayName = String(input.clanName ?? "").trim() || input.clanTag;
  const content = [
    `<@&${input.leadRoleId}> ⚠️ **${displayName}** (\`${input.clanTag}\`) needs an FWA weight update.`,
    `Last submitted: **${age.ageText ?? "unknown"}**`,
    `Alert threshold: **${input.thresholdDays} days**`,
    buildFwaWeightPageUrl(input.clanTag),
  ].join("\n");
  return content.slice(0, MAX_MESSAGE_LENGTH);
}

/** Purpose: evaluate persisted FWA weight policy and durably deliver one alert per clan/date episode. */
export class FwaWeightAlertDeliveryService {
  private readonly db: FwaWeightAlertDeliveryDb;
  private readonly clock: () => Date;
  private readonly randomUUID: () => string;
  private readonly staleClaimMs: number;

  constructor(dependencies: FwaWeightAlertDeliveryDependencies = {}) {
    this.db = dependencies.db ?? (prisma as unknown as FwaWeightAlertDeliveryDb);
    this.clock = dependencies.clock ?? (() => new Date());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
    this.staleClaimMs = Math.max(
      1,
      dependencies.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
    );
  }

  async evaluateAndDeliver(input: {
    client: FwaWeightAlertDeliveryClient;
    now?: Date;
    pollingMode?: "active" | "mirror";
    runtimeEnvironment?: string;
  }): Promise<FwaWeightAlertDeliveryResult> {
    const startedAt = Date.now();
    const counts = emptyCounts();
    const now = input.now ?? this.clock();
    if (
      input.pollingMode === "mirror" ||
      isMirrorPollingMode() ||
      String(input.runtimeEnvironment ?? "").trim().toLowerCase() === "staging"
    ) {
      counts.skippedCount = 1;
      dozzleLog.info("[fwa-weight-alert] cycle_skipped reason=mirror_or_staging");
      return { counts, durationMs: Date.now() - startedAt, skippedReason: "mirror_or_staging" };
    }
    if (!isValidDate(now)) {
      dozzleLog.warn("[fwa-weight-alert] cycle_skipped reason=invalid_clock");
      return { counts, durationMs: Date.now() - startedAt };
    }

    const configs = await this.db.fwaWeightAlertConfig.findMany({
      where: { enabled: true },
      select: { clanTag: true, thresholdDays: true },
    });
    counts.evaluatedConfigCount = configs.length;
    const tags = [...new Set(configs.map((config) => canonicalTag(config.clanTag)).filter(Boolean))];
    if (tags.length === 0) {
      this.logCycle(counts, startedAt);
      return { counts, durationMs: Date.now() - startedAt };
    }

    const [catalogRows, trackedRows] = await Promise.all([
      this.db.fwaClanCatalog.findMany({
        where: { clanTag: { in: tags.map((tag) => `#${tag}`) } },
        select: { clanTag: true, name: true, weightSubmitDate: true },
      }),
      this.db.trackedClan.findMany({
        where: { tag: { in: tags.map((tag) => `#${tag}`) } },
        select: { tag: true, name: true, leaderChannelId: true, leadRoleId: true },
      }),
    ]);
    const catalogByTag = new Map(catalogRows.map((row) => [canonicalTag(row.clanTag), row]));
    const trackedByTag = new Map(trackedRows.map((row) => [canonicalTag(row.tag), row]));

    for (const config of configs) {
      const tag = canonicalTag(config.clanTag);
      const catalog = catalogByTag.get(tag);
      if (!catalog || catalog.weightSubmitDate === null || catalog.weightSubmitDate === undefined) {
        counts.missingDateCount += 1;
        continue;
      }
      if (!isValidDate(catalog.weightSubmitDate) || catalog.weightSubmitDate.getTime() > now.getTime()) {
        counts.invalidDateCount += 1;
        continue;
      }
      const thresholdDays = Number(config.thresholdDays);
      if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 365) {
        counts.invalidDateCount += 1;
        continue;
      }
      if (now.getTime() < catalog.weightSubmitDate.getTime() + thresholdDays * DAY_MS) {
        counts.notDueCount += 1;
        continue;
      }
      const tracked = trackedByTag.get(tag);
      if (!tracked?.leaderChannelId || !tracked.leadRoleId) {
        counts.missingRoutingCount += 1;
        continue;
      }
      counts.eligibleCount += 1;
      const claim = await this.claim({
        clanTag: tracked.tag,
        weightSubmitDate: catalog.weightSubmitDate,
        now,
      });
      if (claim.kind === "already_sent") {
        counts.alreadySentCount += 1;
        continue;
      }
      if (claim.kind === "claimed_recently") {
        counts.claimedRecentlyCount += 1;
        continue;
      }
      if (claim.kind === "contended") {
        counts.skippedCount += 1;
        continue;
      }
      counts.claimedCount += 1;
      if (claim.retry) counts.retryCount += 1;
      await this.deliver({
        client: input.client,
        claim,
        clanTag: tracked.tag,
        clanName: tracked.name ?? catalog.name,
        channelId: tracked.leaderChannelId,
        leadRoleId: tracked.leadRoleId,
        weightSubmitDate: catalog.weightSubmitDate,
        thresholdDays,
        now,
        counts,
      });
    }

    this.logCycle(counts, startedAt);
    return { counts, durationMs: Date.now() - startedAt };
  }

  private async claim(input: {
    clanTag: string;
    weightSubmitDate: Date;
    now: Date;
  }): Promise<ClaimResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.fwaWeightAlertDelivery.findUnique({
          where: {
            clanTag_weightSubmitDate: {
              clanTag: input.clanTag,
              weightSubmitDate: input.weightSubmitDate,
            },
          },
        });
        if (existing?.status === "SENT") return { kind: "already_sent" };
        if (
          existing?.status === "CLAIMED" &&
          existing.claimedAt instanceof Date &&
          existing.claimedAt.getTime() > input.now.getTime() - this.staleClaimMs
        ) {
          return { kind: "claimed_recently" };
        }

        const claimToken = this.randomUUID();
        const wasFailed = existing?.status === "FAILED";
        if (!existing) {
          const created = await tx.fwaWeightAlertDelivery.create({
            data: {
              clanTag: input.clanTag,
              weightSubmitDate: input.weightSubmitDate,
              status: "CLAIMED",
              claimToken,
              claimedAt: input.now,
              lastAttemptAt: input.now,
              attemptCount: 1,
            },
          });
          return { kind: "claimed", id: created.id, claimToken, retry: false };
        }

        const update = await tx.fwaWeightAlertDelivery.updateMany({
          where: {
            id: existing.id,
            OR: [
              { status: "FAILED" },
              { status: "CLAIMED", claimedAt: null },
              { status: "CLAIMED", claimedAt: { lte: new Date(input.now.getTime() - this.staleClaimMs) } },
            ],
          },
          data: {
            status: "CLAIMED",
            claimToken,
            claimedAt: input.now,
            lastAttemptAt: input.now,
            attemptCount: { increment: 1 },
            failureCode: null,
            failureReason: null,
          },
        });
        return update.count === 1
          ? { kind: "claimed", id: existing.id, claimToken, retry: wasFailed }
          : { kind: "contended" };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: "contended" };
      throw error;
    }
  }

  private async deliver(input: {
    client: FwaWeightAlertDeliveryClient;
    claim: Extract<ClaimResult, { kind: "claimed" }>;
    clanTag: string;
    clanName: string | null;
    channelId: string;
    leadRoleId: string;
    weightSubmitDate: Date;
    thresholdDays: number;
    now: Date;
    counts: FwaWeightAlertDeliveryCounts;
  }): Promise<void> {
    try {
      const channel = (await input.client.channels.fetch(input.channelId).catch(() => null)) as
        | SendableTextChannel
        | null;
      if (!channel || channel.isTextBased?.() !== true || typeof channel.send !== "function") {
        throw Object.assign(new Error("Configured leader channel is not text-sendable."), {
          code: "INVALID_LEADER_CHANNEL",
        });
      }
      const message = await channel.send({
        content: buildAlertMessage(input),
        allowedMentions: { parse: [], roles: [input.leadRoleId] },
      });
      const markedSent = await this.db.fwaWeightAlertDelivery.updateMany({
        where: {
          id: input.claim.id,
          status: "CLAIMED",
          claimToken: input.claim.claimToken,
        },
        data: {
          status: "SENT",
          sentAt: input.now,
          discordMessageId: message?.id ?? null,
          failureCode: null,
          failureReason: null,
        },
      });
      if (markedSent.count !== 1) {
        throw new Error("Alert was sent but its delivery claim could not be finalized.");
      }
      input.counts.sentCount += 1;
    } catch (error) {
      input.counts.failedCount += 1;
      await this.db.fwaWeightAlertDelivery.updateMany({
        where: {
          id: input.claim.id,
          status: "CLAIMED",
          claimToken: input.claim.claimToken,
        },
        data: {
          status: "FAILED",
          failureCode: failureCode(error),
          failureReason: boundedFailureReason(error),
        },
      });
      dozzleLog.warn(
        `[fwa-weight-alert] delivery_failed clan=${input.clanTag} channel=${input.channelId} error=${boundedFailureReason(error)}`,
      );
    }
  }

  private logCycle(counts: FwaWeightAlertDeliveryCounts, startedAt: number): void {
    dozzleLog.info(
      `[fwa-weight-alert] cycle_complete configs=${counts.evaluatedConfigCount} eligible=${counts.eligibleCount} claimed=${counts.claimedCount} retry=${counts.retryCount} sent=${counts.sentCount} failed=${counts.failedCount} already_sent=${counts.alreadySentCount} not_due=${counts.notDueCount} missing_date=${counts.missingDateCount} invalid_date=${counts.invalidDateCount} missing_routing=${counts.missingRoutingCount} duration_ms=${Date.now() - startedAt}`,
    );
  }
}

export const fwaWeightAlertDeliveryService = new FwaWeightAlertDeliveryService();
