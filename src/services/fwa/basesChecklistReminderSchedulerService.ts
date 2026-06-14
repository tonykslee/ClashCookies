import { type Client } from "discord.js";
import { dozzleLog } from "../../helper/dozzleLogger";
import { formatError } from "../../helper/formatError";
import {
  isMirrorPollingMode,
  resolveRuntimeEnvironment,
} from "../PollingModeService";
import { TRACKED_MESSAGE_STATUS, trackedMessageService } from "../TrackedMessageService";
import {
  buildFwaBasesChecklistReminderContent,
  findPendingFwaBasesChecklistReminderCandidates,
  type FwaBasesChecklistReminderCandidate,
} from "./basesChecklistReminderService";

export const DEFAULT_FWA_BASES_CHECKLIST_REMINDER_INTERVAL_MS = 60 * 1000;
export const FWA_BASES_CHECKLIST_REMINDER_SCHEDULER_JOB_KEY =
  "fwa_bases_checklist_reminder_scheduler";
export const FWA_BASES_CHECKLIST_REMINDER_SCHEDULER_DISPLAY_NAME =
  "FWA bases checklist reminder scheduler";

export type FwaBasesChecklistReminderSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" | "staging" };

export type FwaBasesChecklistReminderSchedulerCounts = {
  evaluated: number;
  sent: number;
  deduped: number;
  skipped: number;
  failed: number;
};

function createZeroCounts(): FwaBasesChecklistReminderSchedulerCounts {
  return {
    evaluated: 0,
    sent: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
  };
}

function buildReminderTimeLeftLabel(battleDayStart: Date, nowMs: number): string {
  const battleDayStartMs = battleDayStart.getTime();
  const durationMs = Math.max(0, battleDayStartMs - nowMs);
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (minutes === 0) return `${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resolveReminderContent(input: {
  candidate: FwaBasesChecklistReminderCandidate;
  nowMs: number;
}): { content: string; allowedMentions: { parse: []; roles?: string[] } } {
  const clanLabel =
    input.candidate.clanShortName?.trim() ||
    input.candidate.clanName?.trim() ||
    input.candidate.clanTag;
  const clanRoleId = String(input.candidate.clanRoleId ?? "").trim();
  return {
    content: buildFwaBasesChecklistReminderContent({
      clanLabel,
      clanTag: input.candidate.clanTag,
      timeLeftLabel: buildReminderTimeLeftLabel(
        input.candidate.battleDayStart,
        input.nowMs,
      ),
      clanRoleId: clanRoleId || null,
    }),
    allowedMentions: clanRoleId
      ? { roles: [clanRoleId], parse: [] }
      : { parse: [] },
  };
}

function isMatchTypeMm(matchType: string | null | undefined): boolean {
  return String(matchType ?? "").trim().toUpperCase() === "MM";
}

function isSendableTextChannel(channel: unknown): channel is {
  isTextBased: () => boolean;
  send: (payload: {
    content: string;
    allowedMentions: { parse: []; roles?: string[] };
  }) => Promise<{ id: string; url?: string | null }>;
} {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as {
    isTextBased?: unknown;
    send?: unknown;
  };
  return (
    typeof candidate.isTextBased === "function" &&
    candidate.isTextBased() &&
    typeof candidate.send === "function"
  );
}

function classifySendFailureReason(err: unknown): string {
  const code = String((err as { code?: string | number } | null | undefined)?.code ?? "").trim();
  if (code === "50013" || code === "50001") return "missing_permissions";
  if (code === "10003" || code === "10008") return "unavailable_channel";
  return "send_failed";
}

/** Purpose: run the Bases checklist reminder loop safely without changing public checklist output. */
export class FwaBasesChecklistReminderSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly client: Client,
    private readonly intervalMs: number = DEFAULT_FWA_BASES_CHECKLIST_REMINDER_INTERVAL_MS,
  ) {}

  start(): FwaBasesChecklistReminderSchedulerStartResult {
    const pollingMode = isMirrorPollingMode(process.env) ? "mirror" : "active";
    const runtimeEnvironment = resolveRuntimeEnvironment(process.env);
    dozzleLog.info(
      `[fwa bases-check reminder] scheduler_start_requested interval_ms=${this.intervalMs} has_timer=${Boolean(this.timer)} polling_mode=${pollingMode} runtime=${runtimeEnvironment}`,
    );

    if (isMirrorPollingMode(process.env)) {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_bases_checklist_reminder_scheduler mode=mirror",
      );
      return { started: false, reason: "mirror" };
    }
    if (runtimeEnvironment === "staging") {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_bases_checklist_reminder_scheduler mode=staging",
      );
      return { started: false, reason: "staging" };
    }
    if (this.timer) {
      dozzleLog.debug(
        `[fwa bases-check reminder] scheduler_start_skipped reason=already_started interval_ms=${this.intervalMs}`,
      );
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((err) => {
      dozzleLog.error(
        `[fwa bases-check reminder] immediate_cycle_failed error=${formatError(err)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        dozzleLog.error(
          `[fwa bases-check reminder] interval_cycle_failed error=${formatError(err)}`,
        );
      });
    }, this.intervalMs);

    dozzleLog.info(
      `[fwa bases-check reminder] scheduler_started interval_ms=${this.intervalMs}`,
    );
    return { started: true };
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(nowMs: number = Date.now()): Promise<FwaBasesChecklistReminderSchedulerCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[fwa bases-check reminder] cycle_skipped reason=in_flight");
      return createZeroCounts();
    }
    if (isMirrorPollingMode(process.env) || resolveRuntimeEnvironment(process.env) === "staging") {
      dozzleLog.debug(
        `[fwa bases-check reminder] cycle_skipped reason=${isMirrorPollingMode(process.env) ? "mirror" : "staging"}`,
      );
      return createZeroCounts();
    }

    this.inFlight = true;
    try {
      const candidates = await findPendingFwaBasesChecklistReminderCandidates({
        now: new Date(nowMs),
      });
      let evaluated = candidates.length;
      let sent = 0;
      let deduped = 0;
      let skipped = 0;
      let failed = 0;

      for (const candidate of candidates) {
        dozzleLog.debug(
          `[fwa bases-check reminder] candidate_evaluated guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId ?? "missing"} destinationChannelKind=${candidate.destinationChannelKind ?? "missing"}`,
        );

        if (isMatchTypeMm(candidate.matchType)) {
          skipped += 1;
          dozzleLog.info(
            `[fwa bases-check reminder] reminder_skipped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId ?? "missing"} reason=mm_match_type`,
          );
          continue;
        }

        const currentSyncIdentity = candidate.syncMessageId ?? null;
        const currentSyncIdentitySource = candidate.syncIdentitySource ?? "none";
        const currentBaseSwap = await trackedMessageService
          .findLatestActiveFwaBaseSwapTrackedMessageForClan({
            guildId: candidate.guildId,
            clanTag: candidate.clanTag,
            syncMessageId: currentSyncIdentity,
          })
          .catch(() => null);
        const currentBaseSwapStatus = currentBaseSwap?.status ?? null;
        const currentBaseSwapCompleted =
          Boolean(currentBaseSwap) &&
          currentBaseSwapStatus === TRACKED_MESSAGE_STATUS.COMPLETED;
        const activeCompletion = await trackedMessageService
          .findLatestActiveFwaMatchChecklistBasesCompletionForClan({
            guildId: candidate.guildId,
            clanTag: candidate.clanTag,
            warId: candidate.warId,
            warStartTime: candidate.battleDayStart,
            opponentTag: candidate.opponentTag,
            syncMessageId: currentSyncIdentity,
            syncReferenceId: currentSyncIdentity,
          })
          .catch(() => null);
        if (currentBaseSwap || activeCompletion) {
          skipped += 1;
          const suppressionReason = currentBaseSwap
            ? currentBaseSwapCompleted
              ? "base_swap_completed"
              : "base_swap_active_issues"
            : "bases_completion_exists";
          dozzleLog.info(
            `[fwa bases-check reminder] reminder_skipped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId ?? "missing"} reason=${suppressionReason} syncIdentitySource=${currentSyncIdentitySource} syncMessageId=${currentSyncIdentity ?? "missing"} baseSwapMessageId=${currentBaseSwap?.messageId ?? "missing"} completionMessageId=${activeCompletion?.messageId ?? "missing"}`,
          );
          continue;
        }

        const claimed = await trackedMessageService
          .claimFwaBasesChecklistReminderMarker({
            guildId: candidate.guildId,
            channelId: candidate.destinationChannelId ?? "missing-channel",
            clanTag: candidate.clanTag,
            clanName: candidate.clanName,
            warId: candidate.warId,
            opponentTag: candidate.opponentTag,
            warStartTime: candidate.battleDayStart,
            bucketHours: candidate.dueBucketHours,
            destinationChannelId: candidate.destinationChannelId,
            destinationChannelKind: candidate.destinationChannelKind,
            clanRoleId: candidate.clanRoleId,
            createdByUserId: "system",
            createdAtIso: new Date(nowMs).toISOString(),
          })
          .catch((err) => {
            failed += 1;
            dozzleLog.error(
              `[fwa bases-check reminder] marker_claim_failed guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId ?? "missing"} error=${formatError(err)}`,
            );
            return false;
          });
        if (!claimed) {
          deduped += 1;
          dozzleLog.debug(
            `[fwa bases-check reminder] candidate_deduped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId ?? "missing"}`,
          );
          continue;
        }

        if (!candidate.destinationChannelId) {
          skipped += 1;
          dozzleLog.warn(
            `[fwa bases-check reminder] reminder_skipped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=missing reason=missing_channel`,
          );
          continue;
        }

        const channel = await this.client.channels.fetch(candidate.destinationChannelId).catch((err) => {
          dozzleLog.warn(
            `[fwa bases-check reminder] reminder_skipped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId} reason=unavailable_channel error=${formatError(err)}`,
          );
          return null;
        });
        if (!isSendableTextChannel(channel)) {
          skipped += 1;
          dozzleLog.warn(
            `[fwa bases-check reminder] reminder_skipped guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId} reason=unavailable_channel`,
          );
          continue;
        }

        const payload = resolveReminderContent({
          candidate,
          nowMs,
        });
        try {
          await channel.send(payload);
          sent += 1;
          dozzleLog.info(
            `[fwa bases-check reminder] reminder_sent guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId} role_ping=${String(candidate.clanRoleId ?? "").trim() ? "yes" : "no"}`,
          );
        } catch (err) {
          failed += 1;
          dozzleLog.error(
            `[fwa bases-check reminder] reminder_failed guild=${candidate.guildId} clan=${candidate.clanTag} bucketHours=${candidate.dueBucketHours} destinationChannelId=${candidate.destinationChannelId} reason=${classifySendFailureReason(err)} error=${formatError(err)}`,
          );
        }
      }

      dozzleLog.debug(
        `[fwa bases-check reminder] cycle_complete evaluated=${evaluated} sent=${sent} deduped=${deduped} skipped=${skipped} failed=${failed}`,
      );
      return { evaluated, sent, deduped, skipped, failed };
    } catch (err) {
      dozzleLog.error(
        `[fwa bases-check reminder] cycle_failed error=${formatError(err)}`,
      );
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}
