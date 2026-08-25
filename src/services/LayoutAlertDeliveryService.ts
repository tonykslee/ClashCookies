import { type Client } from "discord.js";
import { LayoutAlertDeliveryStatus, LayoutAlertMode } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import { buildDiscordJumpUrl } from "./LayoutPostPublicationService";
import { deriveLayoutFreshnessTimestamp } from "./LayoutService";
import { BotLogChannelService } from "./BotLogChannelService";
import { LAYOUT_ALERT_STALE_AFTER_DAYS } from "./LayoutAlertConfigService";
import { parseClashLayoutLink } from "./ClashLayoutLinkService";
import { isMirrorPollingMode, resolveRuntimeEnvironment } from "./PollingModeService";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;
const DEFAULT_FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_FAILURE_REASON_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 1_900;

type LayoutAlertRecord = {
  id: string;
  layoutLink: string;
  title: string | null;
  lastConfirmedAt: Date | null;
  submittedAt: Date;
  postedByDiscordUserId: string | null;
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordMessageId: string | null;
};

type LayoutAlertConfigRow = {
  layoutId: string;
  mode: LayoutAlertMode;
  customChannelId: string | null;
  layout: LayoutAlertRecord;
};

type LayoutAlertDeliveryRow = {
  id: string;
  status: LayoutAlertDeliveryStatus;
  claimToken: string | null;
  claimedAt: Date | null;
  lastAttemptAt: Date | null;
  attemptCount: number;
};

type LayoutAlertDeliveryDb = {
  layoutAlertConfig: {
    findMany: (args?: unknown) => Promise<LayoutAlertConfigRow[]>;
    findUnique: (args: unknown) => Promise<{ layoutId: string; mode: LayoutAlertMode; customChannelId: string | null } | null>;
  };
  layoutRecord: {
    findUnique: (args: unknown) => Promise<LayoutAlertRecord | null>;
  };
  layoutAlertDelivery: {
    findUnique: (args: unknown) => Promise<LayoutAlertDeliveryRow | null>;
    create: (args: unknown) => Promise<LayoutAlertDeliveryRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  $transaction: <T>(callback: (tx: LayoutAlertDeliveryDb) => Promise<T>) => Promise<T>;
};

type SendableChannel = {
  guildId?: string | null;
  isTextBased?: () => boolean;
  send?: (payload: {
    content: string;
    allowedMentions: { parse: []; users?: string[] };
  }) => Promise<{ id?: string | null }>;
};

type SendableUser = {
  send?: (payload: {
    content: string;
    allowedMentions: { parse: [] };
  }) => Promise<{ id?: string | null }>;
};

export type LayoutAlertDeliveryClient = Pick<Client, "channels" | "users">;

export type LayoutAlertDeliveryCounts = {
  configs: number;
  eligibleLayouts: number;
  eligibleTargets: number;
  claimed: number;
  sent: number;
  failed: number;
  deduped: number;
  retryDeferred: number;
  recentClaims: number;
  superseded: number;
  unknownFreshness: number;
  notDue: number;
  missingRouting: number;
  skipped: number;
};

export type LayoutAlertDeliveryResult = {
  counts: LayoutAlertDeliveryCounts;
  durationMs: number;
  skippedReason?: "mirror" | "staging";
};

type LayoutAlertDeliveryDependencies = {
  db?: LayoutAlertDeliveryDb;
  botLogChannelService?: Pick<BotLogChannelService, "getChannelIdForType">;
  clock?: () => Date;
  randomUUID?: () => string;
  staleClaimMs?: number;
  failedRetryMs?: number;
};

type ClaimResult =
  | { kind: "claimed"; id: string; claimToken: string; retry: boolean; attempt: number }
  | { kind: "deduped" }
  | { kind: "retry_deferred" }
  | { kind: "recent_claim" }
  | { kind: "superseded" }
  | { kind: "contended" };

type DeliveryTarget = "DM" | "CHANNEL";

function emptyCounts(): LayoutAlertDeliveryCounts {
  return {
    configs: 0,
    eligibleLayouts: 0,
    eligibleTargets: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    deduped: 0,
    retryDeferred: 0,
    recentClaims: 0,
    superseded: 0,
    unknownFreshness: 0,
    notDue: 0,
    missingRouting: 0,
    skipped: 0,
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isP2002(error: unknown): boolean {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "") === "P2002";
}

function boundedFailureReason(error: unknown): string {
  return formatError(error).replace(/https?:\/\/\S+/gi, "[url]").slice(0, MAX_FAILURE_REASON_LENGTH);
}

function failureCode(error: unknown): string {
  const code = String((error as { code?: unknown } | null | undefined)?.code ?? "").trim();
  return (code || "DELIVERY_FAILED").slice(0, 100);
}

function completeProvenance(layout: LayoutAlertRecord): boolean {
  return Boolean(
    layout.discordGuildId?.trim() &&
      layout.discordChannelId?.trim() &&
      layout.discordMessageId?.trim(),
  );
}

function targetsForMode(mode: LayoutAlertMode): DeliveryTarget[] {
  if (mode === LayoutAlertMode.DM) return ["DM"];
  if (mode === LayoutAlertMode.BOTH) return ["DM", "CHANNEL"];
  return ["CHANNEL"];
}

function modeIncludesTarget(mode: LayoutAlertMode, target: DeliveryTarget): boolean {
  return targetsForMode(mode).includes(target);
}

function buildAlertMessage(input: {
  layout: LayoutAlertRecord;
  freshnessAnchor: Date;
  jumpUrl: string;
  mentionPoster: boolean;
}): string {
  const parsed = parseClashLayoutLink(input.layout.layoutLink);
  const kind = parsed.layoutKind.replace(/[-_]+/g, " ").toUpperCase();
  const title = (input.layout.title?.trim() || `TH${parsed.townHall} ${kind}`).slice(0, 200);
  const ageLine = input.layout.lastConfirmedAt
    ? `Last confirmed: <t:${Math.floor(input.layout.lastConfirmedAt.getTime() / 1000)}:R>`
    : `Submitted: <t:${Math.floor(input.freshnessAnchor.getTime() / 1000)}:R>\nNo successful-open confirmation is recorded.`;
  const mention = input.mentionPoster && input.layout.postedByDiscordUserId
    ? ` <@${input.layout.postedByDiscordUserId}>`
    : "";
  return [
    `⚠️ This Clash layout has not been confirmed active in ${LAYOUT_ALERT_STALE_AFTER_DAYS} days.${mention}`,
    `**${title}**`,
    ageLine,
    `[View canonical post](${input.jumpUrl})`,
    "Open Layout Link and choose **Yes, It Opened** if it still works.",
  ].join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

/** Purpose: durably claim and deliver one independent alert per layout freshness episode and target. */
export class LayoutAlertDeliveryService {
  private readonly db: LayoutAlertDeliveryDb;
  private readonly botLogChannelService: Pick<BotLogChannelService, "getChannelIdForType">;
  private readonly clock: () => Date;
  private readonly randomUUID: () => string;
  private readonly staleClaimMs: number;
  private readonly failedRetryMs: number;

  constructor(dependencies: LayoutAlertDeliveryDependencies = {}) {
    this.db = dependencies.db ?? (prisma as unknown as LayoutAlertDeliveryDb);
    this.botLogChannelService = dependencies.botLogChannelService ?? new BotLogChannelService();
    this.clock = dependencies.clock ?? (() => new Date());
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
    this.staleClaimMs = Math.max(1, dependencies.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS);
    this.failedRetryMs = Math.max(1, dependencies.failedRetryMs ?? DEFAULT_FAILED_RETRY_MS);
  }

  async evaluateAndDeliver(input: {
    client: LayoutAlertDeliveryClient;
    now?: Date;
    pollingMode?: "active" | "mirror";
    runtimeEnvironment?: string;
  }): Promise<LayoutAlertDeliveryResult> {
    const startedAt = Date.now();
    const counts = emptyCounts();
    const now = input.now ?? this.clock();
    const mirror = input.pollingMode === "mirror" || isMirrorPollingMode();
    const staging = String(input.runtimeEnvironment ?? resolveRuntimeEnvironment()).trim().toLowerCase() === "staging";
    if (mirror || staging) {
      counts.skipped = 1;
      dozzleLog.warn(`[layout-alert] cycle_skipped reason=${mirror ? "mirror" : "staging"}`);
      return {
        counts,
        durationMs: Date.now() - startedAt,
        skippedReason: mirror ? "mirror" : "staging",
      };
    }
    if (!isValidDate(now)) {
      counts.skipped = 1;
      dozzleLog.warn("[layout-alert] cycle_skipped reason=invalid_clock");
      return { counts, durationMs: Date.now() - startedAt };
    }

    const configs = await this.db.layoutAlertConfig.findMany({
      select: {
        layoutId: true,
        mode: true,
        customChannelId: true,
        layout: {
          select: {
            id: true,
            layoutLink: true,
            title: true,
            lastConfirmedAt: true,
            submittedAt: true,
            postedByDiscordUserId: true,
            discordGuildId: true,
            discordChannelId: true,
            discordMessageId: true,
          },
        },
      },
    });
    counts.configs = configs.length;

    for (const config of configs) {
      try {
        await this.evaluateConfig({ config, client: input.client, now, counts });
      } catch (error) {
        counts.skipped += 1;
        dozzleLog.warn(`[layout-alert] config_skipped layout_id=${config.layoutId} reason=${failureCode(error)}`);
      }
    }

    this.logCycle(counts, startedAt);
    return { counts, durationMs: Date.now() - startedAt };
  }

  private async evaluateConfig(input: {
    config: LayoutAlertConfigRow;
    client: LayoutAlertDeliveryClient;
    now: Date;
    counts: LayoutAlertDeliveryCounts;
  }): Promise<void> {
    const layout = input.config.layout;
    if (!completeProvenance(layout)) {
      input.counts.missingRouting += 1;
      return;
    }
    const freshnessAnchor = deriveLayoutFreshnessTimestamp(layout);
    if (!freshnessAnchor || !isValidDate(freshnessAnchor)) {
      input.counts.unknownFreshness += 1;
      return;
    }
    if (freshnessAnchor.getTime() > input.now.getTime()) {
      input.counts.unknownFreshness += 1;
      return;
    }
    if (input.now.getTime() < freshnessAnchor.getTime() + LAYOUT_ALERT_STALE_AFTER_DAYS * DAY_MS) {
      input.counts.notDue += 1;
      return;
    }
    const targets = targetsForMode(input.config.mode);
    if (targets.includes("CHANNEL") && input.config.mode === LayoutAlertMode.CUSTOM_CHANNEL && !input.config.customChannelId?.trim()) {
      input.counts.missingRouting += 1;
      dozzleLog.warn(`[layout-alert] routing_missing layout_id=${layout.id} target=CHANNEL reason=missing_custom_channel`);
      return;
    }
    input.counts.eligibleLayouts += 1;
    input.counts.eligibleTargets += targets.length;

    for (const target of targets) {
      const claim = await this.claim({ layoutId: layout.id, freshnessAnchor, target, now: input.now });
      if (claim.kind === "deduped") {
        input.counts.deduped += 1;
        continue;
      }
      if (claim.kind === "retry_deferred") {
        input.counts.retryDeferred += 1;
        continue;
      }
      if (claim.kind === "recent_claim") {
        input.counts.recentClaims += 1;
        continue;
      }
      if (claim.kind === "superseded") {
        input.counts.superseded += 1;
        continue;
      }
      if (claim.kind === "contended") continue;
      input.counts.claimed += 1;
      await this.deliver({
        claim,
        target,
        layoutId: layout.id,
        freshnessAnchor,
        client: input.client,
        now: input.now,
        counts: input.counts,
      });
    }
  }

  private async claim(input: {
    layoutId: string;
    freshnessAnchor: Date;
    target: DeliveryTarget;
    now: Date;
  }): Promise<ClaimResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.layoutAlertDelivery.findUnique({
          where: {
            layoutId_freshnessAnchorAt_target: {
              layoutId: input.layoutId,
              freshnessAnchorAt: input.freshnessAnchor,
              target: input.target,
            },
          },
        });
        if (existing?.status === LayoutAlertDeliveryStatus.SENT) return { kind: "deduped" };
        if (existing?.status === LayoutAlertDeliveryStatus.SUPERSEDED) return { kind: "superseded" };
        if (
          existing?.status === LayoutAlertDeliveryStatus.CLAIMED &&
          existing.claimedAt instanceof Date &&
          existing.claimedAt.getTime() > input.now.getTime() - this.staleClaimMs
        ) {
          return { kind: "recent_claim" };
        }
        if (
          existing?.status === LayoutAlertDeliveryStatus.FAILED &&
          existing.lastAttemptAt instanceof Date &&
          existing.lastAttemptAt.getTime() > input.now.getTime() - this.failedRetryMs
        ) {
          return { kind: "retry_deferred" };
        }

        const claimToken = this.randomUUID();
        if (!existing) {
          const created = await tx.layoutAlertDelivery.create({
            data: {
              layoutId: input.layoutId,
              freshnessAnchorAt: input.freshnessAnchor,
              target: input.target,
              status: LayoutAlertDeliveryStatus.CLAIMED,
              claimToken,
              claimedAt: input.now,
              lastAttemptAt: input.now,
              attemptCount: 1,
            },
          });
          return { kind: "claimed", id: created.id, claimToken, retry: false, attempt: 1 };
        }
        const update = await tx.layoutAlertDelivery.updateMany({
          where: {
            id: existing.id,
            OR: [
              { status: LayoutAlertDeliveryStatus.FAILED, lastAttemptAt: null },
              {
                status: LayoutAlertDeliveryStatus.FAILED,
                lastAttemptAt: { lte: new Date(input.now.getTime() - this.failedRetryMs) },
              },
              { status: LayoutAlertDeliveryStatus.CLAIMED, claimedAt: null },
              {
                status: LayoutAlertDeliveryStatus.CLAIMED,
                claimedAt: { lte: new Date(input.now.getTime() - this.staleClaimMs) },
              },
            ],
          },
          data: {
            status: LayoutAlertDeliveryStatus.CLAIMED,
            claimToken,
            claimedAt: input.now,
            lastAttemptAt: input.now,
            attemptCount: { increment: 1 },
            failureCode: null,
            failureReason: null,
          },
        });
        return update.count === 1
          ? { kind: "claimed", id: existing.id, claimToken, retry: true, attempt: existing.attemptCount + 1 }
          : { kind: "contended" };
      });
    } catch (error) {
      if (isP2002(error)) return { kind: "contended" };
      throw error;
    }
  }

  private async deliver(input: {
    claim: Extract<ClaimResult, { kind: "claimed" }>;
    target: DeliveryTarget;
    layoutId: string;
    freshnessAnchor: Date;
    client: LayoutAlertDeliveryClient;
    now: Date;
    counts: LayoutAlertDeliveryCounts;
  }): Promise<void> {
    let destinationId: string | null = null;
    try {
      const source = await this.revalidateSource(input);
      if (source.kind === "superseded") {
        input.counts.superseded += 1;
        return;
      }
      if (source.kind === "policy_changed") {
        await this.markFailed(input, source.code, source.reason, null);
        input.counts.failed += 1;
        dozzleLog.warn(
          `[layout-alert] delivery_failed delivery_id=${input.claim.id} layout_id=${input.layoutId} target=${input.target} attempt=${input.claim.attempt} failure_code=${source.code}`,
        );
        return;
      }

      const route = await this.resolveDestination({
        target: input.target,
        config: source.config,
        layout: source.layout,
        client: input.client,
      });
      destinationId = route.destinationId;
      const jumpUrl = buildDiscordJumpUrl(
        source.layout.discordGuildId!,
        source.layout.discordChannelId!,
        source.layout.discordMessageId!,
      );
      const content = buildAlertMessage({
        layout: source.layout,
        freshnessAnchor: input.freshnessAnchor,
        jumpUrl,
        mentionPoster: input.target === "CHANNEL",
      });
      const message = await route.send(content, source.layout.postedByDiscordUserId);
      const finalized = await this.db.layoutAlertDelivery.updateMany({
        where: { id: input.claim.id, status: LayoutAlertDeliveryStatus.CLAIMED, claimToken: input.claim.claimToken },
        data: {
          status: LayoutAlertDeliveryStatus.SENT,
          sentAt: input.now,
          destinationId,
          discordMessageId: message?.id ?? null,
          claimToken: null,
          claimedAt: null,
          failureCode: null,
          failureReason: null,
        },
      });
      if (finalized.count !== 1) throw new Error("Alert sent but its delivery claim could not be finalized.");
      input.counts.sent += 1;
      dozzleLog.info(
        `[layout-alert] delivery_sent delivery_id=${input.claim.id} layout_id=${input.layoutId} target=${input.target} destination_id=${destinationId} message_id=${message?.id ?? "none"}`,
      );
    } catch (error) {
      input.counts.failed += 1;
      const code = failureCode(error);
      if (["MISSING_DEFAULT_CHANNEL", "MISSING_CUSTOM_CHANNEL", "INVALID_ALERT_CHANNEL"].includes(code)) {
        input.counts.missingRouting += 1;
        dozzleLog.warn(
          `[layout-alert] routing_missing layout_id=${input.layoutId} target=${input.target} failure_code=${code}`,
        );
      }
      await this.markFailed(input, code, boundedFailureReason(error), destinationId);
      dozzleLog.warn(
        `[layout-alert] delivery_failed delivery_id=${input.claim.id} layout_id=${input.layoutId} target=${input.target} attempt=${input.claim.attempt} failure_code=${code}`,
      );
    }
  }

  private async revalidateSource(input: {
    claim: Extract<ClaimResult, { kind: "claimed" }>;
    layoutId: string;
    freshnessAnchor: Date;
    target: DeliveryTarget;
  }): Promise<
    | { kind: "ready"; layout: LayoutAlertRecord; config: { mode: LayoutAlertMode; customChannelId: string | null } }
    | { kind: "superseded" }
    | { kind: "policy_changed"; code: string; reason: string }
  > {
    const [layout, config] = await Promise.all([
      this.db.layoutRecord.findUnique({ where: { id: input.layoutId } }),
      this.db.layoutAlertConfig.findUnique({ where: { layoutId: input.layoutId } }),
    ]);
    if (!layout) return { kind: "policy_changed", code: "LAYOUT_MISSING", reason: "Layout record no longer exists." };
    const currentAnchor = deriveLayoutFreshnessTimestamp(layout);
    if (!currentAnchor || !isValidDate(currentAnchor) || currentAnchor.getTime() !== input.freshnessAnchor.getTime()) {
      await this.markSuperseded(input);
      dozzleLog.warn(`[layout-alert] episode_superseded layout_id=${input.layoutId} delivery_id=${input.claim.id}`);
      return { kind: "superseded" };
    }
    if (!config || !modeIncludesTarget(config.mode, input.target)) {
      return { kind: "policy_changed", code: "POLICY_CHANGED", reason: "Alert policy no longer includes this target." };
    }
    if (!completeProvenance(layout)) {
      return { kind: "policy_changed", code: "MISSING_CANONICAL_POST", reason: "Canonical layout post is no longer available." };
    }
    return { kind: "ready", layout, config };
  }

  private async resolveDestination(input: {
    target: DeliveryTarget;
    config: { mode: LayoutAlertMode; customChannelId: string | null };
    layout: LayoutAlertRecord;
    client: LayoutAlertDeliveryClient;
  }): Promise<{
    destinationId: string;
    send: (content: string, posterId: string | null) => Promise<{ id?: string | null }>;
  }> {
    if (input.target === "DM") {
      const userId = input.layout.postedByDiscordUserId?.trim();
      if (!userId) throw Object.assign(new Error("No poster is recorded for this layout."), { code: "MISSING_POSTER" });
      const user = await input.client.users.fetch(userId).catch(() => null) as SendableUser | null;
      if (!user || typeof user.send !== "function") {
        throw Object.assign(new Error("The recorded poster cannot receive direct messages."), { code: "DM_UNAVAILABLE" });
      }
      const sendDm = user.send;
      return {
        destinationId: userId,
        send: (content) => sendDm({ content, allowedMentions: { parse: [] } }),
      };
    }

    const guildId = input.layout.discordGuildId!.trim();
    const channelId = input.config.mode === LayoutAlertMode.CUSTOM_CHANNEL
      ? input.config.customChannelId?.trim() ?? ""
      : await this.botLogChannelService.getChannelIdForType(guildId, "layout-alerts") ?? "";
    if (!channelId) {
      throw Object.assign(new Error("No layout-alerts channel is configured."), {
        code: input.config.mode === LayoutAlertMode.CUSTOM_CHANNEL ? "MISSING_CUSTOM_CHANNEL" : "MISSING_DEFAULT_CHANNEL",
      });
    }
    const channel = await input.client.channels.fetch(channelId).catch(() => null) as SendableChannel | null;
    if (!channel || channel.guildId && channel.guildId !== guildId || channel.isTextBased?.() !== true || typeof channel.send !== "function") {
      throw Object.assign(new Error("The configured alert channel is not text-sendable in the canonical guild."), { code: "INVALID_ALERT_CHANNEL" });
    }
    return {
      destinationId: channelId,
      send: (content, posterId) => channel.send!({
        content,
        allowedMentions: posterId ? { parse: [], users: [posterId] } : { parse: [] },
      }),
    };
  }

  private async markFailed(
    input: { claim: Extract<ClaimResult, { kind: "claimed" }> },
    code: string,
    reason: string,
    destinationId: string | null,
  ): Promise<void> {
    await this.db.layoutAlertDelivery.updateMany({
      where: { id: input.claim.id, status: LayoutAlertDeliveryStatus.CLAIMED, claimToken: input.claim.claimToken },
      data: {
        status: LayoutAlertDeliveryStatus.FAILED,
        destinationId,
        claimToken: null,
        claimedAt: null,
        failureCode: code.slice(0, 100),
        failureReason: reason.slice(0, MAX_FAILURE_REASON_LENGTH),
      },
    });
  }

  private async markSuperseded(input: {
    claim: Extract<ClaimResult, { kind: "claimed" }>;
  }): Promise<void> {
    await this.db.layoutAlertDelivery.updateMany({
      where: { id: input.claim.id, status: LayoutAlertDeliveryStatus.CLAIMED, claimToken: input.claim.claimToken },
      data: { status: LayoutAlertDeliveryStatus.SUPERSEDED, claimToken: null, claimedAt: null, failureCode: null, failureReason: null },
    });
  }

  private logCycle(counts: LayoutAlertDeliveryCounts, startedAt: number): void {
    dozzleLog.debug(
      `[layout-alert] cycle_complete configs=${counts.configs} eligibleLayouts=${counts.eligibleLayouts} eligibleTargets=${counts.eligibleTargets} claimed=${counts.claimed} sent=${counts.sent} failed=${counts.failed} deduped=${counts.deduped} retryDeferred=${counts.retryDeferred} recentClaims=${counts.recentClaims} superseded=${counts.superseded} unknownFreshness=${counts.unknownFreshness} notDue=${counts.notDue} missingRouting=${counts.missingRouting} skipped=${counts.skipped} duration_ms=${Date.now() - startedAt}`,
    );
  }
}

export const layoutAlertDeliveryService = new LayoutAlertDeliveryService();
