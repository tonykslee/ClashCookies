import { Client } from "discord.js";

export type WarMailTrackedTarget = {
  channelId: string;
  messageId: string;
  warId: string | null;
  warStartMs: number | null;
  source: "stored_message" | "mail_config" | "in_memory";
};

export type WarMailReconciliationOutcome =
  | "not_checked"
  | "exists"
  | "message_missing_confirmed"
  | "channel_missing_confirmed"
  | "channel_inaccessible"
  | "transient_error";

export type WarMailNormalizedStatus =
  | "live_matching_post_exists"
  | "tracked_post_missing"
  | "tracked_post_mismatch"
  | "transient_unverified"
  | "no_post_tracked";

export type ResolveWarMailStatusResult = {
  status: WarMailNormalizedStatus;
  reconciliationOutcome: WarMailReconciliationOutcome;
  trackingCleared: boolean;
  hasTrackedTarget: boolean;
};

type ResolveWarMailStatusParams = {
  client: Client | null | undefined;
  guildId: string | null;
  clanTag: string;
  matchesCurrentMailConfig: boolean;
  trackedTarget: WarMailTrackedTarget | null;
  onDefinitiveMissing?: (input: {
    guildId: string;
    clanTag: string;
    target: WarMailTrackedTarget;
    outcome: "message_missing_confirmed" | "channel_missing_confirmed";
  }) => Promise<boolean | void>;
};

/** Purpose: pull a numeric Discord error code from unknown errors. */
function getDiscordErrorCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

/** Purpose: detect transient Discord/network failures that should not clear tracking. */
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

export class WarMailStatusService {
  /** Purpose: classify channel fetch failures into deterministic reconciliation outcomes. */
  private classifyChannelFetchFailure(err: unknown): WarMailReconciliationOutcome {
    const code = getDiscordErrorCode(err);
    if (code === 10003) return "channel_missing_confirmed";
    if (code === 50001 || code === 50013) return "channel_inaccessible";
    if (isLikelyTransientDiscordError(err)) return "transient_error";
    return "transient_error";
  }

  /** Purpose: classify message fetch failures into deterministic reconciliation outcomes. */
  private classifyMessageFetchFailure(err: unknown): WarMailReconciliationOutcome {
    const code = getDiscordErrorCode(err);
    if (code === 10008) return "message_missing_confirmed";
    if (code === 10003) return "channel_missing_confirmed";
    if (code === 50001 || code === 50013) return "channel_inaccessible";
    if (isLikelyTransientDiscordError(err)) return "transient_error";
    return "transient_error";
  }

  /** Purpose: resolve final mail status by reconciling tracked refs against live Discord message existence. */
  async resolveStatus(params: ResolveWarMailStatusParams): Promise<ResolveWarMailStatusResult> {
    if (!params.guildId) {
      return {
        status: "no_post_tracked",
        reconciliationOutcome: "not_checked",
        trackingCleared: false,
        hasTrackedTarget: false,
      };
    }
    if (!params.trackedTarget) {
      return {
        status: "no_post_tracked",
        reconciliationOutcome: "not_checked",
        trackingCleared: false,
        hasTrackedTarget: false,
      };
    }
    if (!params.matchesCurrentMailConfig) {
      return {
        status: "tracked_post_mismatch",
        reconciliationOutcome: "not_checked",
        trackingCleared: false,
        hasTrackedTarget: true,
      };
    }
    if (!params.client) {
      return {
        status: "transient_unverified",
        reconciliationOutcome: "transient_error",
        trackingCleared: false,
        hasTrackedTarget: true,
      };
    }

    const target = params.trackedTarget;
    let channel: unknown;
    try {
      channel = await params.client.channels.fetch(target.channelId);
    } catch (err) {
      const reconciliationOutcome = this.classifyChannelFetchFailure(err);
      return this.finalizeNonExistsResult(params, target, reconciliationOutcome);
    }
    if (!channel) {
      return this.finalizeNonExistsResult(params, target, "channel_missing_confirmed");
    }

    const maybeTextChannel = channel as {
      isTextBased?: () => boolean;
      messages?: { fetch: (messageId: string) => Promise<unknown> };
    };
    if (!maybeTextChannel.isTextBased || !maybeTextChannel.isTextBased()) {
      return this.finalizeNonExistsResult(params, target, "channel_inaccessible");
    }
    if (!maybeTextChannel.messages || typeof maybeTextChannel.messages.fetch !== "function") {
      return this.finalizeNonExistsResult(params, target, "transient_error");
    }

    try {
      const message = await maybeTextChannel.messages.fetch(target.messageId);
      if (!message) {
        return this.finalizeNonExistsResult(params, target, "message_missing_confirmed");
      }
    } catch (err) {
      const reconciliationOutcome = this.classifyMessageFetchFailure(err);
      return this.finalizeNonExistsResult(params, target, reconciliationOutcome);
    }

    return {
      status: "live_matching_post_exists",
      reconciliationOutcome: "exists",
      trackingCleared: false,
      hasTrackedTarget: true,
    };
  }

  /** Purpose: apply definitive-missing cleanup policy and map non-exists outcomes to normalized status. */
  private async finalizeNonExistsResult(
    params: ResolveWarMailStatusParams,
    target: WarMailTrackedTarget,
    reconciliationOutcome: WarMailReconciliationOutcome
  ): Promise<ResolveWarMailStatusResult> {
    if (
      reconciliationOutcome === "message_missing_confirmed" ||
      reconciliationOutcome === "channel_missing_confirmed"
    ) {
      let trackingCleared = false;
      if (params.onDefinitiveMissing) {
        try {
          const cleared = await params.onDefinitiveMissing({
            guildId: params.guildId ?? "",
            clanTag: params.clanTag,
            target,
            outcome: reconciliationOutcome,
          });
          trackingCleared = cleared !== false;
        } catch {
          trackingCleared = false;
        }
      }
      return {
        status: "tracked_post_missing",
        reconciliationOutcome,
        trackingCleared,
        hasTrackedTarget: true,
      };
    }
    return {
      status: "transient_unverified",
      reconciliationOutcome,
      trackingCleared: false,
      hasTrackedTarget: true,
    };
  }
}

