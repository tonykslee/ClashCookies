import { WarMailLifecycleStatus } from "@prisma/client";
import { Client } from "discord.js";
import { prisma } from "../prisma";

export type WarMailLifecycleNormalizedStatus = "not_posted" | "posted" | "deleted";

export type WarMailLifecycleReconciliationOutcome =
  | "not_checked"
  | "exists"
  | "message_missing_confirmed"
  | "channel_missing_confirmed"
  | "channel_inaccessible"
  | "transient_error";

export type WarMailLifecycleDebugWinningSource = "WarMailLifecycle" | "none";

export type WarMailLifecycleDebugReasonCode =
  | "live_matching_post_exists"
  | "tracked_post_missing_message"
  | "tracked_post_missing_channel"
  | "transient_channel_inaccessible"
  | "transient_unverified"
  | "no_post_tracked";

export type WarMailLifecycleStatusDebugInfo = {
  currentWarId: string | null;
  trackedMailWarId: string | null;
  trackedChannelId: string | null;
  trackedMessageId: string | null;
  trackedMessageExists: "yes" | "no" | "unknown";
  currentWarConfigMatchesTrackedMessage: boolean;
  winningSource: WarMailLifecycleDebugWinningSource;
  finalNormalizedStatus: WarMailLifecycleNormalizedStatus;
  reconciliationOutcome: WarMailLifecycleReconciliationOutcome;
  reconciliationCertainty: "definitive" | "uncertain" | "not_checked";
  debugReasonCode: WarMailLifecycleDebugReasonCode;
  debugReason: string;
  environmentMismatchSignal: boolean;
  trackingCleared: boolean;
};

export type ResolveWarMailLifecycleStatusResult = {
  status: WarMailLifecycleNormalizedStatus;
  mailStatusEmoji: string;
  debug: WarMailLifecycleStatusDebugInfo;
};

type ResolveWarMailLifecycleStatusParams = {
  client: Client | null | undefined;
  guildId: string | null;
  clanTag: string;
  warId: number | null | undefined;
  emitDebugLog?: boolean;
  sentEmoji: string;
  unsentEmoji: string;
};

type UpsertPostedLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId: number;
  channelId: string;
  messageId: string;
  postedAt?: Date;
};

type MarkDeletedLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId: number;
  deletedAt?: Date;
};

type GetLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId: number;
};

type FindByMessageInput = {
  guildId: string;
  channelId: string;
  messageId: string;
};

/** Purpose: normalize clan tags for deterministic lifecycle lookups. */
function normalizeTag(input: string): string {
  return `#${input.trim().toUpperCase().replace(/^#/, "")}`;
}

/** Purpose: detect likely transient network or Discord failures. */
function isLikelyTransientDiscordError(err: unknown): boolean {
  const message = String((err as { message?: unknown } | null | undefined)?.message ?? "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("eai_again") ||
    message.includes("enotfound") ||
    message.includes("network")
  );
}

/** Purpose: read numeric Discord API error codes from unknown thrown values. */
function getDiscordErrorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

/** Purpose: map reconciliation outcomes to yes/no/unknown existence summaries. */
function toTrackedExists(
  outcome: WarMailLifecycleReconciliationOutcome
): "yes" | "no" | "unknown" {
  if (outcome === "exists") return "yes";
  if (outcome === "message_missing_confirmed" || outcome === "channel_missing_confirmed") {
    return "no";
  }
  return "unknown";
}

/** Purpose: map reconciliation outcomes to certainty labels for safe debugging. */
function toCertainty(
  outcome: WarMailLifecycleReconciliationOutcome
): "definitive" | "uncertain" | "not_checked" {
  if (outcome === "not_checked") return "not_checked";
  if (
    outcome === "exists" ||
    outcome === "message_missing_confirmed" ||
    outcome === "channel_missing_confirmed"
  ) {
    return "definitive";
  }
  return "uncertain";
}

/** Purpose: derive concise reason-code metadata for debug diagnostics. */
function deriveDebugReason(params: {
  status: WarMailLifecycleNormalizedStatus;
  outcome: WarMailLifecycleReconciliationOutcome;
}): { code: WarMailLifecycleDebugReasonCode; reason: string } {
  if (params.status === "posted" && params.outcome === "exists") {
    return {
      code: "live_matching_post_exists",
      reason: "Tracked lifecycle message exists for the active war.",
    };
  }
  if (params.status === "deleted" && params.outcome === "message_missing_confirmed") {
    return {
      code: "tracked_post_missing_message",
      reason: "Tracked lifecycle message is definitively missing/deleted; lifecycle was marked DELETED.",
    };
  }
  if (params.status === "deleted" && params.outcome === "channel_missing_confirmed") {
    return {
      code: "tracked_post_missing_channel",
      reason: "Tracked lifecycle channel is definitively missing; lifecycle was marked DELETED.",
    };
  }
  if (params.status === "posted" && params.outcome === "channel_inaccessible") {
    return {
      code: "transient_channel_inaccessible",
      reason: "Tracked lifecycle channel is inaccessible; lifecycle remains POSTED.",
    };
  }
  if (params.status === "posted" && params.outcome === "transient_error") {
    return {
      code: "transient_unverified",
      reason: "Tracked lifecycle message could not be verified due to transient fetch failure.",
    };
  }
  return {
    code: "no_post_tracked",
    reason: "No POSTED lifecycle row exists for the active war.",
  };
}

export class WarMailLifecycleService {
  /** Purpose: persist lifecycle status=POSTED for one clan and one war. */
  async markPosted(input: UpsertPostedLifecycleInput): Promise<void> {
    const clanTag = normalizeTag(input.clanTag);
    const postedAt = input.postedAt ?? new Date();
    await prisma.warMailLifecycle.upsert({
      where: {
        guildId_clanTag_warId: {
          guildId: input.guildId,
          clanTag,
          warId: Math.trunc(input.warId),
        },
      },
      create: {
        guildId: input.guildId,
        clanTag,
        warId: Math.trunc(input.warId),
        status: WarMailLifecycleStatus.POSTED,
        channelId: input.channelId,
        messageId: input.messageId,
        postedAt,
        deletedAt: null,
      },
      update: {
        status: WarMailLifecycleStatus.POSTED,
        channelId: input.channelId,
        messageId: input.messageId,
        postedAt,
        deletedAt: null,
      },
    });
    console.info(
      `[mail-lifecycle] guild=${input.guildId} clan=${clanTag} war=${Math.trunc(input.warId)} status=POSTED`
    );
  }

  /** Purpose: persist lifecycle status=DELETED for one clan and one war. */
  async markDeleted(input: MarkDeletedLifecycleInput): Promise<boolean> {
    const clanTag = normalizeTag(input.clanTag);
    const deletedAt = input.deletedAt ?? new Date();
    const updated = await prisma.warMailLifecycle.updateMany({
      where: {
        guildId: input.guildId,
        clanTag,
        warId: Math.trunc(input.warId),
      },
      data: {
        status: WarMailLifecycleStatus.DELETED,
        deletedAt,
      },
    });
    if (updated.count > 0) {
      console.info(
        `[mail-lifecycle] guild=${input.guildId} clan=${clanTag} war=${Math.trunc(input.warId)} status=DELETED`
      );
      return true;
    }
    return false;
  }

  /** Purpose: fetch one lifecycle row by guild/clan/war identity. */
  async getLifecycleForWar(input: GetLifecycleInput) {
    const clanTag = normalizeTag(input.clanTag);
    return prisma.warMailLifecycle.findUnique({
      where: {
        guildId_clanTag_warId: {
          guildId: input.guildId,
          clanTag,
          warId: Math.trunc(input.warId),
        },
      },
    });
  }

  /** Purpose: resolve lifecycle row by concrete Discord message target. */
  async findLifecycleByMessage(input: FindByMessageInput) {
    return prisma.warMailLifecycle.findFirst({
      where: {
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        status: WarMailLifecycleStatus.POSTED,
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  /** Purpose: derive lifecycle status + debug diagnostics for the active war of a clan. */
  async resolveStatusForCurrentWar(
    params: ResolveWarMailLifecycleStatusParams
  ): Promise<ResolveWarMailLifecycleStatusResult> {
    const normalizedTag = normalizeTag(params.clanTag);
    const warId =
      params.warId !== null &&
      params.warId !== undefined &&
      Number.isFinite(params.warId)
        ? Math.trunc(params.warId)
        : null;
    if (!params.guildId || warId === null) {
      return {
        status: "not_posted",
        mailStatusEmoji: params.unsentEmoji,
        debug: this.buildDebugInfo({
          currentWarId: warId !== null ? String(warId) : null,
          trackedWarId: null,
          channelId: null,
          messageId: null,
          status: "not_posted",
          outcome: "not_checked",
          trackingCleared: false,
        }),
      };
    }

    const row = await this.getLifecycleForWar({
      guildId: params.guildId,
      clanTag: normalizedTag,
      warId,
    });
    if (!row || row.status !== WarMailLifecycleStatus.POSTED) {
      const status: WarMailLifecycleNormalizedStatus =
        row?.status === WarMailLifecycleStatus.DELETED ? "deleted" : "not_posted";
      const outcome: WarMailLifecycleReconciliationOutcome = "not_checked";
      const debug = this.buildDebugInfo({
        currentWarId: String(warId),
        trackedWarId: row ? String(row.warId) : null,
        channelId: row?.channelId ?? null,
        messageId: row?.messageId ?? null,
        status,
        outcome,
        trackingCleared: false,
      });
      this.logDebug(params, normalizedTag, debug);
      return {
        status,
        mailStatusEmoji: params.unsentEmoji,
        debug,
      };
    }

    if (!row.channelId || !row.messageId) {
      const trackingCleared = await this.markDeleted({
        guildId: params.guildId,
        clanTag: normalizedTag,
        warId,
      }).catch(() => false);
      this.logReconcile({
        guildId: params.guildId,
        clanTag: normalizedTag,
        warId,
        outcome: "message_missing_confirmed",
        action: trackingCleared ? "mark_deleted" : "no_change",
      });
      const debug = this.buildDebugInfo({
        currentWarId: String(warId),
        trackedWarId: String(row.warId),
        channelId: row.channelId ?? null,
        messageId: row.messageId ?? null,
        status: "deleted",
        outcome: "message_missing_confirmed",
        trackingCleared,
      });
      this.logDebug(params, normalizedTag, debug);
      return {
        status: "deleted",
        mailStatusEmoji: params.unsentEmoji,
        debug,
      };
    }

    const reconciliation = await this.checkMessageExistence({
      client: params.client,
      channelId: row.channelId,
      messageId: row.messageId,
    });
    if (
      reconciliation === "message_missing_confirmed" ||
      reconciliation === "channel_missing_confirmed"
    ) {
      const trackingCleared = await this.markDeleted({
        guildId: params.guildId,
        clanTag: normalizedTag,
        warId,
      }).catch(() => false);
      this.logReconcile({
        guildId: params.guildId,
        clanTag: normalizedTag,
        warId,
        outcome: reconciliation,
        action: trackingCleared ? "mark_deleted" : "no_change",
      });
      const debug = this.buildDebugInfo({
        currentWarId: String(warId),
        trackedWarId: String(row.warId),
        channelId: row.channelId,
        messageId: row.messageId,
        status: "deleted",
        outcome: reconciliation,
        trackingCleared,
      });
      this.logDebug(params, normalizedTag, debug);
      return {
        status: "deleted",
        mailStatusEmoji: params.unsentEmoji,
        debug,
      };
    }

    const debug = this.buildDebugInfo({
      currentWarId: String(warId),
      trackedWarId: String(row.warId),
      channelId: row.channelId,
      messageId: row.messageId,
      status: "posted",
      outcome: reconciliation,
      trackingCleared: false,
    });
    this.logReconcile({
      guildId: params.guildId,
      clanTag: normalizedTag,
      warId,
      outcome: reconciliation,
      action: "no_change",
    });
    this.logDebug(params, normalizedTag, debug);
    return {
      status: "posted",
      mailStatusEmoji: params.sentEmoji,
      debug,
    };
  }

  /** Purpose: classify Discord channel/message fetches into safe lifecycle reconciliation outcomes. */
  private async checkMessageExistence(input: {
    client: Client | null | undefined;
    channelId: string;
    messageId: string;
  }): Promise<WarMailLifecycleReconciliationOutcome> {
    if (!input.client) return "transient_error";
    let channel: unknown;
    try {
      channel = await input.client.channels.fetch(input.channelId);
    } catch (err) {
      const code = getDiscordErrorCode(err);
      if (code === 10003) return "channel_missing_confirmed";
      if (code === 50001 || code === 50013) return "channel_inaccessible";
      return isLikelyTransientDiscordError(err) ? "transient_error" : "transient_error";
    }
    if (!channel) return "channel_missing_confirmed";
    const maybeTextChannel = channel as {
      isTextBased?: () => boolean;
      messages?: { fetch: (messageId: string) => Promise<unknown> };
    };
    if (!maybeTextChannel.isTextBased || !maybeTextChannel.isTextBased()) {
      return "channel_inaccessible";
    }
    if (!maybeTextChannel.messages || typeof maybeTextChannel.messages.fetch !== "function") {
      return "transient_error";
    }
    try {
      const message = await maybeTextChannel.messages.fetch(input.messageId);
      return message ? "exists" : "message_missing_confirmed";
    } catch (err) {
      const code = getDiscordErrorCode(err);
      if (code === 10008) return "message_missing_confirmed";
      if (code === 10003) return "channel_missing_confirmed";
      if (code === 50001 || code === 50013) return "channel_inaccessible";
      return isLikelyTransientDiscordError(err) ? "transient_error" : "transient_error";
    }
  }

  /** Purpose: produce a consistent debug snapshot used by `/fwa match` and diagnostics. */
  private buildDebugInfo(input: {
    currentWarId: string | null;
    trackedWarId: string | null;
    channelId: string | null;
    messageId: string | null;
    status: WarMailLifecycleNormalizedStatus;
    outcome: WarMailLifecycleReconciliationOutcome;
    trackingCleared: boolean;
  }): WarMailLifecycleStatusDebugInfo {
    const reason = deriveDebugReason({
      status: input.status,
      outcome: input.outcome,
    });
    return {
      currentWarId: input.currentWarId,
      trackedMailWarId: input.trackedWarId,
      trackedChannelId: input.channelId,
      trackedMessageId: input.messageId,
      trackedMessageExists: toTrackedExists(input.outcome),
      currentWarConfigMatchesTrackedMessage:
        Boolean(input.currentWarId) &&
        Boolean(input.trackedWarId) &&
        input.currentWarId === input.trackedWarId,
      winningSource: input.trackedWarId ? "WarMailLifecycle" : "none",
      finalNormalizedStatus: input.status,
      reconciliationOutcome: input.outcome,
      reconciliationCertainty: toCertainty(input.outcome),
      debugReasonCode: reason.code,
      debugReason: reason.reason,
      environmentMismatchSignal:
        Boolean(input.currentWarId) &&
        Boolean(input.trackedWarId) &&
        input.currentWarId !== input.trackedWarId,
      trackingCleared: input.trackingCleared,
    };
  }

  /** Purpose: emit standardized debug logs without exposing secret values. */
  private logDebug(
    params: ResolveWarMailLifecycleStatusParams,
    normalizedTag: string,
    debug: WarMailLifecycleStatusDebugInfo
  ): void {
    if (!params.emitDebugLog || !params.guildId) return;
    console.info(
      `[fwa-mail-status-debug] guild=${params.guildId} clan=${normalizedTag} current_war_id=${debug.currentWarId ?? "unknown"} tracked_war_id=${debug.trackedMailWarId ?? "none"} tracked_channel_id=${debug.trackedChannelId ?? "none"} tracked_message_id=${debug.trackedMessageId ?? "none"} tracked_exists=${debug.trackedMessageExists} source=${debug.winningSource} normalized_status=${debug.finalNormalizedStatus} reconciliation=${debug.reconciliationOutcome} certainty=${debug.reconciliationCertainty} reason_code=${debug.debugReasonCode} tracking_cleared=${debug.trackingCleared ? "1" : "0"}`
    );
  }

  /** Purpose: emit lightweight reconciliation telemetry for POSTED lifecycle checks. */
  private logReconcile(input: {
    guildId: string;
    clanTag: string;
    warId: number;
    outcome: WarMailLifecycleReconciliationOutcome;
    action: "mark_deleted" | "no_change";
  }): void {
    const messageExists =
      input.outcome === "exists"
        ? "true"
        : input.outcome === "message_missing_confirmed" ||
            input.outcome === "channel_missing_confirmed"
          ? "false"
          : "unknown";
    console.info(
      `[mail-lifecycle-reconcile] guild=${input.guildId} clan=${input.clanTag} war_id=${input.warId} message_exists=${messageExists} outcome=${input.outcome} action=${input.action}`
    );
  }
}
