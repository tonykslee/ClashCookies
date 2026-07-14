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
  | "tracked_post_inaccessible_channel"
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
  warStartTime?: Date | null;
  opponentTag?: string | null;
  emitDebugLog?: boolean;
  sentEmoji: string;
  unsentEmoji: string;
};

type WarMailLifecycleIdentity = {
  guildId: string;
  clanTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
};

type UpsertPostedLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
  channelId: string;
  messageId: string;
  postedAt?: Date;
};

type MarkDeletedLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
  deletedAt?: Date;
  requirePosted?: boolean;
  matchChannelId?: string;
  matchMessageId?: string;
};

type MarkDeletedIfTrackedMessageMatchesInput = {
  guildId: string;
  clanTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
  channelId: string;
  messageId: string;
  deletedAt?: Date;
};

export type MarkDeletedIfTrackedMessageMatchesResult =
  | "deleted"
  | "stale_target"
  | "not_posted"
  | "missing_row";

type GetLifecycleInput = {
  guildId: string;
  clanTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
};

type FindByMessageInput = {
  guildId: string;
  channelId: string;
  messageId: string;
  warId?: number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
};

type ExactWarMailLifecycleIdentity = {
  guildId: string;
  clanTag: string;
  warId: number;
  warStartTime: Date;
  opponentTag: string;
};

type NormalizeExactWarMailLifecycleIdentityInput = {
  guildId: string;
  clanTag: string;
  warId?: number | string | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
};

export type WarMailLifecycleSendClaimAcquireResult =
  | { result: "acquired" }
  | { result: "already_in_flight" }
  | { result: "already_completed" }
  | { result: "invalid_identity" };

type AcquireSendClaimInput = ExactWarMailLifecycleIdentity & {
  sendKey: string;
  claimToken: string;
  claimedAt?: Date | null;
};

type FinalizeSendClaimInput = ExactWarMailLifecycleIdentity & {
  sendKey: string;
  claimToken: string;
  channelId: string;
  messageId: string;
  postedAt: Date;
};

type ReleaseSendClaimInput = ExactWarMailLifecycleIdentity & {
  sendKey: string;
  claimToken: string;
  reason: string;
};

/** Purpose: normalize clan tags for deterministic lifecycle lookups. */
function normalizeTag(input: string): string {
  return `#${input.trim().toUpperCase().replace(/^#/, "")}`;
}

/** Purpose: normalize optional clan tags for logging and lookups. */
function normalizeOptionalTag(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return normalized ? normalized : null;
}

/** Purpose: normalize optional war IDs used in lifecycle identity lookups. */
function normalizeOptionalWarId(input: number | string | null | undefined): number | null {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Purpose: normalize optional lifecycle timestamps for deterministic lookups. */
function normalizeOptionalDate(input: Date | null | undefined): Date | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input : null;
}

/** Purpose: normalize one required clan tag for exact lifecycle identity checks. */
function normalizeRequiredClanTag(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed ? normalizeTag(trimmed) : null;
}

/** Purpose: normalize one required opponent tag for exact lifecycle identity checks. */
function normalizeRequiredOpponentTag(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed ? normalizeOptionalTag(trimmed) : null;
}

/** Purpose: normalize one required claim or send key for guarded lifecycle operations. */
function normalizeRequiredKey(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed ? trimmed : null;
}

/** Purpose: normalize one exact positive war ID for guarded lifecycle operations. */
function normalizeExactPositiveWarId(input: number | string | null | undefined): number | null {
  const value = typeof input === "number" ? input : Number(input);
  return Number.isInteger(value) && value > 0 ? value : null;
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
  if (params.status === "deleted" && params.outcome === "channel_inaccessible") {
    return {
      code: "tracked_post_inaccessible_channel",
      reason: "Tracked lifecycle channel is inaccessible for active-war mail; lifecycle was marked DELETED.",
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
  /** Purpose: classify reconciliation outcomes that should clear unusable active-war POSTED tracking. */
  private shouldMarkDeletedForOutcome(
    outcome: WarMailLifecycleReconciliationOutcome
  ): boolean {
    return (
      outcome === "message_missing_confirmed" ||
      outcome === "channel_missing_confirmed" ||
      outcome === "channel_inaccessible"
    );
  }

  /** Purpose: normalize one active-war lifecycle identity for lookups and logs. */
  private normalizeIdentity(input: WarMailLifecycleIdentity): {
    guildId: string;
    clanTag: string;
    warId: number | null;
    warStartTime: Date | null;
    opponentTag: string | null;
  } {
    return {
      guildId: input.guildId,
      clanTag: normalizeTag(input.clanTag),
      warId: normalizeOptionalWarId(input.warId),
      warStartTime: normalizeOptionalDate(input.warStartTime ?? null),
      opponentTag: normalizeOptionalTag(input.opponentTag ?? null),
    };
  }

  /** Purpose: format lifecycle identity fields for structured diagnostics. */
  private formatIdentityLogFields(input: {
    warId: number | null;
    warStartTime: Date | null;
    opponentTag: string | null;
  }): string {
    return [
      `war_id=${input.warId ?? "none"}`,
      `war_start=${input.warStartTime?.toISOString() ?? "none"}`,
      `opponent=${input.opponentTag ? `#${input.opponentTag}` : "none"}`,
    ].join(" ");
  }

  /** Purpose: format guarded send-claim fields for structured diagnostics. */
  private formatSendClaimLogFields(input: {
    warId: number;
    warStartTime: Date;
    opponentTag: string;
    sendKey: string;
  }): string {
    return [
      `war_id=${input.warId}`,
      `war_start=${input.warStartTime.toISOString()}`,
      `opponent=${input.opponentTag ? `#${input.opponentTag}` : "none"}`,
      `send_key=${input.sendKey}`,
    ].join(" ");
  }

  /** Purpose: normalize one exact active-war identity for guarded claim and finalize operations. */
  private normalizeExactIdentity(
    input: NormalizeExactWarMailLifecycleIdentityInput
  ): ExactWarMailLifecycleIdentity | null {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeRequiredClanTag(input.clanTag);
    const warId = normalizeExactPositiveWarId(input.warId);
    const warStartTime = normalizeOptionalDate(input.warStartTime ?? null);
    const opponentTag = normalizeRequiredOpponentTag(input.opponentTag);
    if (!guildId || !clanTag || warId === null || !warStartTime || !opponentTag) {
      return null;
    }
    return {
      guildId,
      clanTag,
      warId,
      warStartTime,
      opponentTag,
    };
  }

  /** Purpose: log a POSTED lifecycle transition using the same rules as the existing mail updater. */
  private logPostedLifecycleTransition(input: {
    identity: {
      guildId: string;
      clanTag: string;
      warId: number | null;
      warStartTime: Date | null;
      opponentTag: string | null;
    };
    existing: {
      status: WarMailLifecycleStatus;
      channelId: string | null;
      messageId: string | null;
    } | null;
    channelId: string;
    messageId: string;
  }): void {
    const isTransitionToPosted =
      !input.existing || input.existing.status !== WarMailLifecycleStatus.POSTED;
    const postedIdentityChanged =
      input.existing?.channelId !== input.channelId ||
      input.existing?.messageId !== input.messageId;
    const logLine =
      `[mail-lifecycle] guild=${input.identity.guildId} clan=${input.identity.clanTag} ` +
      `${this.formatIdentityLogFields(input.identity)} status=POSTED`;
    if (isTransitionToPosted || postedIdentityChanged) {
      console.info(logLine);
      return;
    }
    console.debug(`${logLine} outcome=noop_reasserted`);
  }

  /** Purpose: resolve one lifecycle row by active-war start time first and legacy war ID second. */
  private async findLifecycleRow(input: WarMailLifecycleIdentity) {
    const identity = this.normalizeIdentity(input);
    if (identity.warStartTime) {
      const row = await prisma.warMailLifecycle.findFirst({
        where: {
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warStartTime: identity.warStartTime,
        },
        orderBy: { updatedAt: "desc" },
      });
      return row;
    }
    if (identity.warId !== null) {
      return prisma.warMailLifecycle.findFirst({
        where: {
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warId: identity.warId,
        },
        orderBy: { updatedAt: "desc" },
      });
    }
    return null;
  }

  /** Purpose: persist lifecycle status=POSTED for one clan and one war. */
  async markPosted(input: UpsertPostedLifecycleInput): Promise<void> {
    const identity = this.normalizeIdentity(input);
    if (!identity.warStartTime && identity.warId === null) {
      throw new Error("markPosted requires warStartTime or warId.");
    }
    const postedAt = input.postedAt ?? new Date();
    const existing = await this.findLifecycleRow(identity);
    if (existing) {
      await prisma.warMailLifecycle.update({
        where: { id: existing.id },
        data: {
          status: WarMailLifecycleStatus.POSTED,
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          channelId: input.channelId,
          messageId: input.messageId,
          postedAt,
          deletedAt: null,
        },
      });
    } else {
      await prisma.warMailLifecycle.create({
        data: {
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          status: WarMailLifecycleStatus.POSTED,
          channelId: input.channelId,
          messageId: input.messageId,
          postedAt,
          deletedAt: null,
        },
      });
    }
    this.logPostedLifecycleTransition({
      identity: {
        guildId: identity.guildId,
        clanTag: identity.clanTag,
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
      },
      existing: existing
        ? {
            status: existing.status,
            channelId: existing.channelId,
            messageId: existing.messageId,
          }
        : null,
      channelId: input.channelId,
      messageId: input.messageId,
    });
  }

  /** Purpose: atomically reserve one active-war mail revision for a single posting attempt. */
  async acquireSendClaim(input: AcquireSendClaimInput): Promise<WarMailLifecycleSendClaimAcquireResult> {
    const identity = this.normalizeExactIdentity(input);
    const sendKey = normalizeRequiredKey(input.sendKey);
    const claimToken = normalizeRequiredKey(input.claimToken);
    const claimedAt = normalizeOptionalDate(input.claimedAt ?? null) ?? new Date();
    if (!identity || !sendKey || !claimToken) {
      console.warn(
        `[mail-lifecycle] event=send_claim_acquire guild=${String(input.guildId ?? "").trim() || "none"} clan=${normalizeRequiredClanTag(input.clanTag) ?? "none"} result=invalid_identity reason=invalid_input`
      );
      return { result: "invalid_identity" };
    }

    const lifecycle = await prisma.$transaction(async (tx) => {
      const ensured = await tx.warMailLifecycle.upsert({
        where: {
          guildId_clanTag_warStartTime: {
            guildId: identity.guildId,
            clanTag: identity.clanTag,
            warStartTime: identity.warStartTime,
          },
        },
        create: {
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          status: WarMailLifecycleStatus.NOT_POSTED,
        },
        update: {},
      });
      if (
        ensured.guildId !== identity.guildId ||
        ensured.clanTag !== identity.clanTag ||
        ensured.warId !== identity.warId ||
        !(ensured.warStartTime instanceof Date) ||
        ensured.warStartTime.getTime() !== identity.warStartTime.getTime() ||
        ensured.opponentTag !== identity.opponentTag
      ) {
        return { result: "invalid_identity" as const };
      }

      const claimed = await tx.warMailLifecycle.updateMany({
        where: {
          id: ensured.id,
          guildId: identity.guildId,
          clanTag: identity.clanTag,
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendClaimToken: null,
          sendClaimKey: null,
          sendClaimedAt: null,
          OR: [
            { lastCompletedSendKey: null },
            { lastCompletedSendKey: { not: sendKey } },
          ],
        },
        data: {
          sendClaimToken: claimToken,
          sendClaimKey: sendKey,
          sendClaimedAt: claimedAt,
        },
      });
      if (claimed.count === 1) {
        return { result: "acquired" as const };
      }

      const current = await tx.warMailLifecycle.findUnique({
        where: { id: ensured.id },
        select: {
          sendClaimToken: true,
          sendClaimKey: true,
          sendClaimedAt: true,
          lastCompletedSendKey: true,
        },
      });
      if (!current) {
        return { result: "invalid_identity" as const };
      }
      if (current.sendClaimToken || current.sendClaimKey || current.sendClaimedAt) {
        return { result: "already_in_flight" as const };
      }
      if (current.lastCompletedSendKey === sendKey) {
        return { result: "already_completed" as const };
      }
      return { result: "invalid_identity" as const };
    });

    if (lifecycle.result === "acquired") {
      console.info(
        `[mail-lifecycle] event=send_claim_acquire guild=${identity.guildId} clan=${identity.clanTag} result=acquired ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
    } else if (lifecycle.result === "already_completed") {
      console.info(
        `[mail-lifecycle] event=send_claim_acquire guild=${identity.guildId} clan=${identity.clanTag} result=already_completed ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
    } else if (lifecycle.result === "already_in_flight") {
      console.warn(
        `[mail-lifecycle] event=send_claim_acquire guild=${identity.guildId} clan=${identity.clanTag} result=already_in_flight reason=active_claim ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
    } else {
      console.warn(
        `[mail-lifecycle] event=send_claim_acquire guild=${identity.guildId} clan=${identity.clanTag} result=invalid_identity reason=stale_or_invalid_identity ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
    }

    return lifecycle;
  }

  /** Purpose: finalize one previously acquired active-war mail claim as the authoritative posted message. */
  async finalizeSendClaim(input: FinalizeSendClaimInput): Promise<boolean> {
    const identity = this.normalizeExactIdentity(input);
    const sendKey = normalizeRequiredKey(input.sendKey);
    const claimToken = normalizeRequiredKey(input.claimToken);
    const channelId = String(input.channelId ?? "").trim();
    const messageId = String(input.messageId ?? "").trim();
    const postedAt = normalizeOptionalDate(input.postedAt ?? null);
    if (!identity || !sendKey || !claimToken || !channelId || !messageId || !postedAt) {
      console.warn(
        `[mail-lifecycle] event=send_claim_finalize guild=${String(input.guildId ?? "").trim() || "none"} clan=${normalizeRequiredClanTag(input.clanTag) ?? "none"} result=invalid_identity reason=invalid_input`
      );
      return false;
    }

    const current = await prisma.warMailLifecycle.findFirst({
      where: {
        guildId: identity.guildId,
        clanTag: identity.clanTag,
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
      },
      select: {
        status: true,
        channelId: true,
        messageId: true,
        sendClaimToken: true,
        sendClaimKey: true,
      },
    });
    const updated = await prisma.warMailLifecycle.updateMany({
      where: {
        guildId: identity.guildId,
        clanTag: identity.clanTag,
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
        sendClaimToken: claimToken,
        sendClaimKey: sendKey,
      },
      data: {
        status: WarMailLifecycleStatus.POSTED,
        channelId,
        messageId,
        postedAt,
        guildId: identity.guildId,
        clanTag: identity.clanTag,
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
        sendClaimToken: null,
        sendClaimKey: null,
        sendClaimedAt: null,
        lastCompletedSendKey: sendKey,
        deletedAt: null,
      },
    });
    if (updated.count !== 1) {
      console.warn(
        `[mail-lifecycle] event=send_claim_finalize guild=${identity.guildId} clan=${identity.clanTag} result=stale reason=token_or_send_key_mismatch ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
      return false;
    }

    this.logPostedLifecycleTransition({
      identity,
      existing: current,
      channelId,
      messageId,
    });
    return true;
  }

  /** Purpose: release one acquired active-war mail claim without mutating the authoritative posted message. */
  async releaseSendClaim(input: ReleaseSendClaimInput): Promise<boolean> {
    const identity = this.normalizeExactIdentity(input);
    const sendKey = normalizeRequiredKey(input.sendKey);
    const claimToken = normalizeRequiredKey(input.claimToken);
    const reason = String(input.reason ?? "").trim() || "unknown";
    if (!identity || !sendKey || !claimToken) {
      console.warn(
        `[mail-lifecycle] event=send_claim_release guild=${String(input.guildId ?? "").trim() || "none"} clan=${normalizeRequiredClanTag(input.clanTag) ?? "none"} result=invalid_identity reason=invalid_input`
      );
      return false;
    }

    const released = await prisma.warMailLifecycle.updateMany({
      where: {
        guildId: identity.guildId,
        clanTag: identity.clanTag,
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
        sendClaimToken: claimToken,
        sendClaimKey: sendKey,
      },
      data: {
        sendClaimToken: null,
        sendClaimKey: null,
        sendClaimedAt: null,
      },
    });
    if (released.count === 1) {
      console.info(
        `[mail-lifecycle] event=send_claim_release guild=${identity.guildId} clan=${identity.clanTag} result=released reason=${reason} ${this.formatSendClaimLogFields({
          warId: identity.warId,
          warStartTime: identity.warStartTime,
          opponentTag: identity.opponentTag,
          sendKey,
        })}`
      );
      return true;
    }

    console.warn(
      `[mail-lifecycle] event=send_claim_release guild=${identity.guildId} clan=${identity.clanTag} result=stale reason=${reason} ${this.formatSendClaimLogFields({
        warId: identity.warId,
        warStartTime: identity.warStartTime,
        opponentTag: identity.opponentTag,
        sendKey,
      })}`
    );
    return false;
  }

  /** Purpose: persist lifecycle status=DELETED for one clan and one war. */
  async markDeleted(input: MarkDeletedLifecycleInput): Promise<boolean> {
    const identity = this.normalizeIdentity(input);
    if (!identity.warStartTime && identity.warId === null) {
      return false;
    }
    const deletedAt = input.deletedAt ?? new Date();
    const where =
      identity.warStartTime !== null
        ? {
            guildId: identity.guildId,
            clanTag: identity.clanTag,
            warStartTime: identity.warStartTime,
            ...(input.requirePosted ? { status: WarMailLifecycleStatus.POSTED } : {}),
            ...(typeof input.matchChannelId === "string" && input.matchChannelId.trim()
              ? { channelId: input.matchChannelId }
              : {}),
            ...(typeof input.matchMessageId === "string" && input.matchMessageId.trim()
              ? { messageId: input.matchMessageId }
              : {}),
          }
        : {
            guildId: identity.guildId,
            clanTag: identity.clanTag,
            warId: identity.warId,
            ...(input.requirePosted ? { status: WarMailLifecycleStatus.POSTED } : {}),
            ...(typeof input.matchChannelId === "string" && input.matchChannelId.trim()
              ? { channelId: input.matchChannelId }
              : {}),
            ...(typeof input.matchMessageId === "string" && input.matchMessageId.trim()
              ? { messageId: input.matchMessageId }
              : {}),
          };
    const updated = await prisma.warMailLifecycle.updateMany({
      where,
      data: {
        status: WarMailLifecycleStatus.DELETED,
        deletedAt,
      },
    });
    if (updated.count > 0) {
      console.info(
        `[mail-lifecycle] guild=${identity.guildId} clan=${identity.clanTag} ${this.formatIdentityLogFields(identity)} status=DELETED`
      );
      return true;
    }
    return false;
  }

  /** Purpose: mark lifecycle DELETED only when the currently tracked active-war message still matches the failing message identity. */
  async markDeletedIfTrackedMessageMatches(
    input: MarkDeletedIfTrackedMessageMatchesInput
  ): Promise<MarkDeletedIfTrackedMessageMatchesResult> {
    const identity = this.normalizeIdentity(input);
    const row = await this.getLifecycleForWar(identity);
    if (!row) {
      return "missing_row";
    }
    if (
      row.status !== WarMailLifecycleStatus.POSTED ||
      !row.channelId ||
      !row.messageId
    ) {
      return "not_posted";
    }
    if (row.channelId !== input.channelId || row.messageId !== input.messageId) {
      console.info(
        `[mail-lifecycle] guild=${input.guildId} clan=${identity.clanTag} ${this.formatIdentityLogFields(identity)} status=NOOP_STALE_TARGET tracked_channel=${row.channelId} tracked_message=${row.messageId} failing_channel=${input.channelId} failing_message=${input.messageId}`
      );
      return "stale_target";
    }
    const deleted = await this.markDeleted({
      guildId: input.guildId,
      clanTag: identity.clanTag,
      warId: identity.warId,
      warStartTime: identity.warStartTime,
      opponentTag: identity.opponentTag,
      deletedAt: input.deletedAt,
      requirePosted: true,
      matchChannelId: input.channelId,
      matchMessageId: input.messageId,
    });
    return deleted ? "deleted" : "stale_target";
  }

  /** Purpose: fetch one lifecycle row by guild/clan/war identity. */
  async getLifecycleForWar(input: GetLifecycleInput) {
    return this.findLifecycleRow(input);
  }

  /** Purpose: resolve lifecycle row by concrete Discord message target. */
  async findLifecycleByMessage(input: FindByMessageInput) {
    const warId = normalizeOptionalWarId(input.warId);
    const warStartTime = normalizeOptionalDate(input.warStartTime ?? null);
    return prisma.warMailLifecycle.findFirst({
      where: {
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        status: WarMailLifecycleStatus.POSTED,
        ...(warStartTime
          ? { warStartTime }
          : warId !== null
            ? { warId }
            : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  /** Purpose: derive lifecycle status + debug diagnostics for the active war of a clan. */
  async resolveStatusForCurrentWar(
    params: ResolveWarMailLifecycleStatusParams
  ): Promise<ResolveWarMailLifecycleStatusResult> {
    const normalizedTag = normalizeTag(params.clanTag);
    const warId = normalizeOptionalWarId(params.warId);
    const warStartTime = normalizeOptionalDate(params.warStartTime ?? null);
    const opponentTag = normalizeOptionalTag(params.opponentTag ?? null);
    if (!params.guildId || (warId === null && warStartTime === null)) {
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
      warStartTime,
      opponentTag,
    });
    if (!row || row.status !== WarMailLifecycleStatus.POSTED) {
      const status: WarMailLifecycleNormalizedStatus =
        row?.status === WarMailLifecycleStatus.DELETED ? "deleted" : "not_posted";
      const outcome: WarMailLifecycleReconciliationOutcome = "not_checked";
      const debug = this.buildDebugInfo({
        currentWarId: warId !== null ? String(warId) : null,
        trackedWarId: row?.warId !== null && row?.warId !== undefined ? String(row.warId) : null,
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
        currentWarId: warId !== null ? String(warId) : null,
        trackedWarId: row.warId !== null && row.warId !== undefined ? String(row.warId) : null,
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
    if (this.shouldMarkDeletedForOutcome(reconciliation)) {
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
        currentWarId: warId !== null ? String(warId) : null,
        trackedWarId: row.warId !== null && row.warId !== undefined ? String(row.warId) : null,
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
      currentWarId: warId !== null ? String(warId) : null,
      trackedWarId: row.warId !== null && row.warId !== undefined ? String(row.warId) : null,
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
    if (!input.client) {
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "none",
        outcome: "transient_error",
      });
      return "transient_error";
    }
    let channel: unknown;
    try {
      channel = await input.client.channels.fetch(input.channelId);
    } catch (err) {
      const code = getDiscordErrorCode(err);
      const outcome: WarMailLifecycleReconciliationOutcome =
        code === 10003
          ? "channel_missing_confirmed"
          : code === 50001 || code === 50013
            ? "channel_inaccessible"
            : "transient_error";
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "none",
        outcome,
      });
      return outcome;
    }
    if (!channel) {
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "none",
        outcome: "channel_missing_confirmed",
      });
      return "channel_missing_confirmed";
    }
    const maybeTextChannel = channel as {
      isTextBased?: () => boolean;
      messages?: { fetch: (options: { message: string; force?: boolean }) => Promise<unknown> };
    };
    if (!maybeTextChannel.isTextBased || !maybeTextChannel.isTextBased()) {
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "none",
        outcome: "channel_inaccessible",
      });
      return "channel_inaccessible";
    }
    if (!maybeTextChannel.messages || typeof maybeTextChannel.messages.fetch !== "function") {
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "none",
        outcome: "transient_error",
      });
      return "transient_error";
    }
    try {
      // Force REST validation to avoid stale cached-message false positives.
      const message = await maybeTextChannel.messages.fetch({
        message: input.messageId,
        force: true,
      });
      const outcome: WarMailLifecycleReconciliationOutcome = message
        ? "exists"
        : "message_missing_confirmed";
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "rest_forced",
        outcome,
      });
      return outcome;
    } catch (err) {
      const code = getDiscordErrorCode(err);
      const outcome: WarMailLifecycleReconciliationOutcome =
        code === 10008
          ? "message_missing_confirmed"
          : code === 10003
            ? "channel_missing_confirmed"
            : code === 50001 || code === 50013
              ? "channel_inaccessible"
              : "transient_error";
      this.logMessageExistenceCheck({
        channelId: input.channelId,
        messageId: input.messageId,
        via: "rest_forced",
        outcome,
      });
      return outcome;
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
    warId: number | null;
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
      `[mail-lifecycle-reconcile] guild=${input.guildId} clan=${input.clanTag} war_id=${input.warId ?? "none"} message_exists=${messageExists} outcome=${input.outcome} action=${input.action}`
    );
  }

  /** Purpose: emit per-check telemetry that records forced-REST usage and final outcome. */
  private logMessageExistenceCheck(input: {
    channelId: string;
    messageId: string;
    via: "rest_forced" | "none";
    outcome: WarMailLifecycleReconciliationOutcome;
  }): void {
    console.info(
      `[mail-lifecycle-message-check] channel_id=${input.channelId} message_id=${input.messageId} via=${input.via} outcome=${input.outcome}`
    );
  }
}
