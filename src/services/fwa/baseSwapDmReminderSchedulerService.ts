import { type Client } from "discord.js";
import { prisma } from "../../prisma";
import { dozzleLog } from "../../helper/dozzleLogger";
import { formatError } from "../../helper/formatError";
import { truncateDiscordContent } from "../../helper/discordContent";
import { normalizeClanTag } from "../PlayerLinkService";
import {
  isMirrorPollingMode,
  resolveRuntimeEnvironment,
} from "../PollingModeService";
import {
  parseFwaBaseSwapMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
} from "../TrackedMessageService";
import {
  buildFwaBaseSwapDmReminderContent,
  claimFwaBaseSwapDmReminderCandidate,
  findPendingFwaBaseSwapDmReminderCandidates,
  isBaseSwapAffectedPlayerDmReminderEnabled,
  releaseFwaBaseSwapDmReminderCandidate,
  type FwaBaseSwapDmReminderCandidate,
  type FwaBaseSwapDmReminderEntry,
} from "./baseSwapDmReminderService";

export const DEFAULT_FWA_BASE_SWAP_DM_REMINDER_INTERVAL_MS = 60 * 1000;
export const FWA_BASE_SWAP_DM_REMINDER_SCHEDULER_JOB_KEY =
  "fwa_base_swap_dm_reminder_scheduler";
export const FWA_BASE_SWAP_DM_REMINDER_SCHEDULER_DISPLAY_NAME =
  "FWA base-swap DM reminder scheduler";

export type FwaBaseSwapDmReminderSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" | "staging" };

export type FwaBaseSwapDmReminderSchedulerCounts = {
  evaluated: number;
  sent: number;
  deduped: number;
  failed: number;
  logFailed: number;
};

type LeaderChannelRow = {
  tag: string;
  name: string | null;
  leaderChannelId: string | null;
};

type CandidateGroupKey = string;

type CandidateGroupState = {
  groupKey: CandidateGroupKey;
  guildId: string;
  clanTag: string;
  clanName: string | null;
  trackedMessageId: string;
  referenceId: string | null;
  messageId: string;
  channelId: string;
  postUrl: string;
  battleDayStart: Date;
  dueOffsetHours: number;
  remainingOffsetHours: number[];
  matchType: string | null;
  entries: FwaBaseSwapDmReminderEntry[];
  sentByUserId: Map<string, FwaBaseSwapDmReminderEntry[]>;
  failedByUserId: Map<string, CandidateDeliveryFailure>;
  dedupedCount: number;
};

type CandidateDeliveryFailureStage = "user_fetch" | "dm_send";

type CandidateDeliveryFailure = {
  stage: CandidateDeliveryFailureStage;
  retryable: boolean;
  claimAction: "released" | "release_failed" | "retained";
  code: string | null;
  status: number | null;
  error: string;
  releaseError: string | null;
};

export type FwaBaseSwapDmReminderSchedulerDeps = {
  findPendingCandidates: typeof findPendingFwaBaseSwapDmReminderCandidates;
  claimCandidate: typeof claimFwaBaseSwapDmReminderCandidate;
  releaseCandidate: typeof releaseFwaBaseSwapDmReminderCandidate;
  buildDmContent: typeof buildFwaBaseSwapDmReminderContent;
  stillPending: typeof stillPendingForCandidate;
  resolveLeaderChannel: typeof resolveLeaderChannelForClanTag;
};

const DEFAULT_FWA_BASE_SWAP_DM_REMINDER_SCHEDULER_DEPS: FwaBaseSwapDmReminderSchedulerDeps = {
  findPendingCandidates: findPendingFwaBaseSwapDmReminderCandidates,
  claimCandidate: claimFwaBaseSwapDmReminderCandidate,
  releaseCandidate: releaseFwaBaseSwapDmReminderCandidate,
  buildDmContent: buildFwaBaseSwapDmReminderContent,
  stillPending: stillPendingForCandidate,
  resolveLeaderChannel: resolveLeaderChannelForClanTag,
};

function createZeroCounts(): FwaBaseSwapDmReminderSchedulerCounts {
  return { evaluated: 0, sent: 0, deduped: 0, failed: 0, logFailed: 0 };
}

function normalizeOffsetHours(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : 0;
}

function buildGroupKey(candidate: FwaBaseSwapDmReminderCandidate): string {
  const clanTag = normalizeClanTag(candidate.clanTag);
  const scopeId = String(candidate.referenceId ?? candidate.trackedMessageId ?? "").trim();
  return [
    String(candidate.guildId ?? "").trim(),
    clanTag,
    scopeId,
    normalizeOffsetHours(candidate.dueOffsetHours),
  ].join("|");
}

function formatReminderEntryList(entries: readonly FwaBaseSwapDmReminderEntry[]): string {
  return [...entries]
    .sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      const nameCompare = a.playerName.localeCompare(b.playerName);
      if (nameCompare !== 0) return nameCompare;
      return a.playerTag.localeCompare(b.playerTag);
    })
    .map((entry) => `#${entry.position} ${entry.playerName}`)
    .join(", ");
}

/** Purpose: extract a stable numeric Discord/HTTP status from unknown delivery failures. */
function readDeliveryFailureStatus(error: unknown): number | null {
  const rawStatus =
    (error as { status?: unknown } | null | undefined)?.status ??
    (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
    return Math.trunc(rawStatus);
  }
  if (typeof rawStatus === "string" && /^\d+$/.test(rawStatus)) {
    return Math.trunc(Number(rawStatus));
  }
  return null;
}

/** Purpose: extract a stable Discord-style error code from unknown delivery failures. */
function readDeliveryFailureCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "number" && Number.isFinite(code)) return String(Math.trunc(code));
  if (typeof code === "string" && code.trim()) return code.trim();
  const causeCode = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  if (typeof causeCode === "number" && Number.isFinite(causeCode)) return String(Math.trunc(causeCode));
  if (typeof causeCode === "string" && causeCode.trim()) return causeCode.trim();
  return null;
}

/** Purpose: classify whether a Discord delivery failure is transient enough to retry later. */
function classifyDiscordDeliveryRetryability(error: unknown): {
  retryable: boolean;
  code: string | null;
  status: number | null;
} {
  const code = readDeliveryFailureCode(error);
  const status = readDeliveryFailureStatus(error);
  const normalizedCode = String(code ?? "").toUpperCase();
  const normalizedMessage = String((error as { message?: unknown } | null | undefined)?.message ?? "")
    .toLowerCase()
    .trim();
  const causeMessage = String((error as { cause?: { message?: unknown } } | null | undefined)?.cause?.message ?? "")
    .toLowerCase()
    .trim();
  const message = `${normalizedMessage} ${causeMessage}`.trim();

  if (status === 429 || status === 408 || status === 425) {
    return { retryable: true, code, status };
  }
  if (typeof status === "number" && status >= 500) {
    return { retryable: true, code, status };
  }

  if (
    normalizedCode === "ECONNRESET" ||
    normalizedCode === "ETIMEDOUT" ||
    normalizedCode === "ECONNABORTED" ||
    normalizedCode === "EAI_AGAIN" ||
    normalizedCode === "ENOTFOUND" ||
    normalizedCode === "UND_ERR_ABORTED"
  ) {
    return { retryable: true, code, status };
  }
  if (
    message.includes("socket hang up") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("temporary") ||
    message.includes("dns")
  ) {
    return { retryable: true, code, status };
  }

  if (
    normalizedCode === "50007" ||
    normalizedCode === "10007" ||
    normalizedCode === "10013" ||
    normalizedCode === "50001" ||
    normalizedCode === "50013" ||
    normalizedCode === "50035" ||
    normalizedCode === "10003" ||
    normalizedCode === "10008"
  ) {
    return { retryable: false, code, status };
  }

  if (typeof status === "number" && status >= 400 && status < 500) {
    return { retryable: false, code, status };
  }

  return { retryable: false, code, status };
}

/** Purpose: format a one-line delivery failure summary for audit logs and leader reports. */
function formatDeliveryFailureSummary(input: CandidateDeliveryFailure): string {
  const parts = [
    input.stage,
    `retryable=${input.retryable ? "true" : "false"}`,
    `claim_action=${input.claimAction}`,
  ];
  if (input.code) parts.push(`code=${input.code}`);
  if (input.status !== null) parts.push(`status=${input.status}`);
  if (input.releaseError) parts.push(`claim_release_error=${truncateDiscordContent(input.releaseError, 120)}`);
  parts.push(`error=${truncateDiscordContent(input.error, 180)}`);
  return parts.join(" ");
}

/** Purpose: build the scheduler's retained failure record after classifying delivery and release outcomes. */
async function handleDeliveryFailure(input: {
  candidate: FwaBaseSwapDmReminderCandidate;
  groupKey: string;
  stage: CandidateDeliveryFailureStage;
  error: unknown;
  releaseCandidate: typeof releaseFwaBaseSwapDmReminderCandidate;
}): Promise<CandidateDeliveryFailure> {
  const classification = classifyDiscordDeliveryRetryability(input.error);
  const baseFailure: CandidateDeliveryFailure = {
    stage: input.stage,
    retryable: classification.retryable,
    claimAction: classification.retryable ? "released" : "retained",
    code: classification.code,
    status: classification.status,
    error: formatError(input.error),
    releaseError: null,
  };

  if (!classification.retryable) {
    dozzleLog.warn(
      `[fwa base-swap dm-reminder] delivery_failed group=${input.groupKey} user=${input.candidate.discordUserId} offset=${input.candidate.dueOffsetHours} ${formatDeliveryFailureSummary(baseFailure)}`,
    );
    return baseFailure;
  }

  try {
    const releaseResult = await input.releaseCandidate({ candidate: input.candidate });
    dozzleLog.warn(
      `[fwa base-swap dm-reminder] delivery_failed group=${input.groupKey} user=${input.candidate.discordUserId} offset=${input.candidate.dueOffsetHours} ${formatDeliveryFailureSummary({
        ...baseFailure,
        claimAction: "released",
        releaseError: null,
      })} claim_released=${releaseResult?.released ? 1 : 0} deleted=${releaseResult?.deletedCount ?? 0}`,
    );
    return {
      ...baseFailure,
      claimAction: "released",
    };
  } catch (releaseError) {
    const releaseErrorText = formatError(releaseError);
    dozzleLog.error(
      `[fwa base-swap dm-reminder] claim_release_failed group=${input.groupKey} user=${input.candidate.discordUserId} offset=${input.candidate.dueOffsetHours} stage=${input.stage} retryable=true claim_action=release_failed code=${classification.code ?? "none"} error=${baseFailure.error} release_error=${releaseErrorText}`,
    );
    return {
      ...baseFailure,
      claimAction: "release_failed",
      releaseError: releaseErrorText,
    };
  }
}

function buildLeaderChannelLogContent(input: CandidateGroupState): string {
  const clanName = String(input.clanName ?? "").trim() || "Unknown Clan";
  const clanTag = normalizeClanTag(input.clanTag);
  const sentLines = [...input.sentByUserId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([discordUserId, entries]) => `- <@${discordUserId}>: ${formatReminderEntryList(entries)}`);
  const failedLines = [...input.failedByUserId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([discordUserId, failure]) => `- <@${discordUserId}>: ${formatDeliveryFailureSummary(failure)}`);

  const lines: string[] = [
    "Base-swap DM reminders",
    `Clan: ${clanName} (#${clanTag})`,
    `Offset: ${input.dueOffsetHours}h before battle day`,
    `Base-swap post: ${input.postUrl}`,
  ];

  if (sentLines.length > 0) {
    lines.push("");
    lines.push("Sent:");
    lines.push(...sentLines);
  }

  if (failedLines.length > 0) {
    lines.push("");
    lines.push("Failed:");
    lines.push(...failedLines);
  }

  lines.push("");
  lines.push(`Skipped/deduped: ${input.dedupedCount}`);
  return truncateDiscordContent(lines.join("\n"));
}

async function resolveLeaderChannelForClanTag(input: {
  client: Client;
  clanTag: string;
}): Promise<{
  clanName: string | null;
  clanTag: string;
  channelId: string;
  send: (payload: {
    content: string;
    allowedMentions?: { parse: [] };
  }) => Promise<unknown>;
} | null> {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag) return null;

  const trackedClan = (await prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: clanTag, mode: "insensitive" } },
        { tag: { equals: clanTag.replace(/^#/, ""), mode: "insensitive" } },
      ],
    },
    select: {
      tag: true,
      name: true,
      leaderChannelId: true,
    },
  })) as LeaderChannelRow | null;
  if (!trackedClan || !String(trackedClan.leaderChannelId ?? "").trim()) {
    return null;
  }

  const channelId = String(trackedClan.leaderChannelId).trim();
  const fetchedChannel = await input.client.channels.fetch(channelId).catch(() => null);
  if (!fetchedChannel) return null;

  const textChannel = fetchedChannel as {
    guildId?: string;
    isTextBased?: () => boolean;
    send?: (payload: {
      content: string;
      allowedMentions?: { parse: [] };
    }) => Promise<unknown>;
  };
  if (
    typeof textChannel.isTextBased !== "function" ||
    !textChannel.isTextBased() ||
    typeof textChannel.send !== "function"
  ) {
    return null;
  }

  return {
    clanName: trackedClan.name ?? null,
    clanTag,
    channelId,
    send: (payload) => textChannel.send!(payload),
  };
}

export const resolveLeaderChannelForClanTagForTest = resolveLeaderChannelForClanTag;

async function stillPendingForCandidate(input: {
  candidate: FwaBaseSwapDmReminderCandidate;
  nowMs: number;
}): Promise<boolean> {
  const candidate = input.candidate;
  const clanTag = normalizeClanTag(candidate.clanTag);
  if (!clanTag) return false;

  const trackedRows = await prisma.trackedMessage.findMany({
    where: {
      guildId: candidate.guildId,
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      expiresAt: { gt: new Date(input.nowMs) },
      OR: [
        { id: candidate.trackedMessageId },
        { messageId: candidate.messageId },
        ...(candidate.referenceId ? [{ referenceId: candidate.referenceId }] : []),
      ],
    },
    orderBy: [{ createdAt: "asc" }],
    select: {
      metadata: true,
    },
  });
  if (trackedRows.length === 0) return false;

  const discordUserId = String(candidate.discordUserId ?? "").trim();
  if (!discordUserId) return false;

  for (const row of trackedRows) {
    const metadata = parseFwaBaseSwapMetadata(row.metadata);
    if (!metadata) continue;
    if (!isBaseSwapAffectedPlayerDmReminderEnabled(metadata)) continue;
    const matched = metadata.entries.some(
      (entry) =>
        String(entry.discordUserId ?? "").trim() === discordUserId &&
        entry.acknowledged !== true,
    );
    if (matched) return true;
  }
  return false;
}

/** Purpose: run the base-swap DM reminder scheduler loop safely without changing any public command output. */
export class FwaBaseSwapDmReminderSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly deps: FwaBaseSwapDmReminderSchedulerDeps;

  constructor(
    private readonly client: Client,
    private readonly intervalMs: number = DEFAULT_FWA_BASE_SWAP_DM_REMINDER_INTERVAL_MS,
    deps: Partial<FwaBaseSwapDmReminderSchedulerDeps> = {},
  ) {
    this.deps = {
      ...DEFAULT_FWA_BASE_SWAP_DM_REMINDER_SCHEDULER_DEPS,
      ...deps,
    };
  }

  start(): FwaBaseSwapDmReminderSchedulerStartResult {
    const pollingMode = isMirrorPollingMode(process.env) ? "mirror" : "active";
    const runtimeEnvironment = resolveRuntimeEnvironment(process.env);
    dozzleLog.info(
      `[fwa base-swap dm-reminder] scheduler_start_requested interval_ms=${this.intervalMs} has_timer=${Boolean(this.timer)} polling_mode=${pollingMode} runtime=${runtimeEnvironment}`,
    );

    if (isMirrorPollingMode(process.env)) {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_base_swap_dm_reminder_scheduler mode=mirror",
      );
      return { started: false, reason: "mirror" };
    }
    if (runtimeEnvironment === "staging") {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_base_swap_dm_reminder_scheduler mode=staging",
      );
      return { started: false, reason: "staging" };
    }
    if (this.timer) {
      dozzleLog.debug(
        `[fwa base-swap dm-reminder] scheduler_start_skipped reason=already_started interval_ms=${this.intervalMs}`,
      );
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((err) => {
      dozzleLog.error(
        `[fwa base-swap dm-reminder] immediate_cycle_failed error=${formatError(err)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        dozzleLog.error(
          `[fwa base-swap dm-reminder] interval_cycle_failed error=${formatError(err)}`,
        );
      });
    }, this.intervalMs);

    dozzleLog.info(
      `[fwa base-swap dm-reminder] scheduler_started interval_ms=${this.intervalMs}`,
    );
    return { started: true };
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(nowMs: number = Date.now()): Promise<FwaBaseSwapDmReminderSchedulerCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[fwa base-swap dm-reminder] cycle_skipped reason=in_flight");
      return createZeroCounts();
    }
    if (isMirrorPollingMode(process.env) || resolveRuntimeEnvironment(process.env) === "staging") {
      dozzleLog.debug(
        `[fwa base-swap dm-reminder] cycle_skipped reason=${isMirrorPollingMode(process.env) ? "mirror" : "staging"}`,
      );
      return createZeroCounts();
    }

    this.inFlight = true;
    try {
      const candidatesByGuild = await this.findCandidatesByGuild(nowMs);
      const candidates = candidatesByGuild.flatMap((rows) => rows);
      let evaluated = candidates.length;
      let sent = 0;
      let deduped = 0;
      let failed = 0;
      let logFailed = 0;

      const groups = new Map<CandidateGroupKey, CandidateGroupState>();
      const getGroup = (candidate: FwaBaseSwapDmReminderCandidate): CandidateGroupState => {
        const groupKey = buildGroupKey(candidate);
        const existing = groups.get(groupKey);
        if (existing) return existing;
        const created: CandidateGroupState = {
          groupKey,
          guildId: candidate.guildId,
          clanTag: normalizeClanTag(candidate.clanTag),
          clanName: candidate.clanName ?? null,
          trackedMessageId: candidate.trackedMessageId,
          referenceId: candidate.referenceId,
          messageId: candidate.messageId,
          channelId: candidate.channelId,
          postUrl: candidate.postUrl,
          battleDayStart: candidate.battleDayStart,
          dueOffsetHours: candidate.dueOffsetHours,
          remainingOffsetHours: candidate.remainingOffsetHours,
          matchType: candidate.matchType ?? null,
          entries: candidate.entries.map((entry) => ({ ...entry })),
          sentByUserId: new Map(),
          failedByUserId: new Map(),
          dedupedCount: 0,
        };
        groups.set(groupKey, created);
        return created;
      };

      for (const candidate of candidates) {
        const group = getGroup(candidate);
        dozzleLog.debug(
          `[fwa base-swap dm-reminder] candidate_evaluated group=${group.groupKey} user=${candidate.discordUserId} offset=${candidate.dueOffsetHours}`,
        );

        const pending = await this.deps.stillPending({
          candidate,
          nowMs,
        });
        if (!pending) {
          deduped += 1;
          group.dedupedCount += 1;
          dozzleLog.debug(
            `[fwa base-swap dm-reminder] candidate_deduped group=${group.groupKey} user=${candidate.discordUserId} offset=${candidate.dueOffsetHours} reason=no_longer_pending`,
          );
          continue;
        }

        const claimed = await this.deps.claimCandidate({ candidate });
        if (!claimed) {
          deduped += 1;
          group.dedupedCount += 1;
          dozzleLog.debug(
            `[fwa base-swap dm-reminder] candidate_deduped group=${group.groupKey} user=${candidate.discordUserId} offset=${candidate.dueOffsetHours} reason=claim_exists`,
          );
          continue;
        }

        const discordUserId = String(candidate.discordUserId ?? "").trim();
        const discordUser = await this.client.users.fetch(discordUserId).catch(async (err) => {
          failed += 1;
          const failure = await handleDeliveryFailure({
            candidate,
            groupKey: group.groupKey,
            stage: "user_fetch",
            error: err,
            releaseCandidate: this.deps.releaseCandidate,
          });
          group.failedByUserId.set(discordUserId, failure);
          return null;
        });
        if (!discordUser) continue;

        const dmContent = this.deps.buildDmContent({
          postUrl: candidate.postUrl,
          battleDayStart: candidate.battleDayStart,
          now: new Date(nowMs),
          remainingOffsetHours: candidate.remainingOffsetHours,
          matchType: candidate.matchType ?? null,
          entries: candidate.entries,
        });

        try {
          await discordUser.send({ content: dmContent });
          sent += 1;
          const existing = group.sentByUserId.get(discordUserId) ?? [];
          existing.push(...candidate.entries);
          group.sentByUserId.set(discordUserId, existing);
          dozzleLog.info(
            `[fwa base-swap dm-reminder] dm_sent group=${group.groupKey} user=${discordUserId} offset=${candidate.dueOffsetHours}`,
          );
        } catch (err) {
          failed += 1;
          const failure = await handleDeliveryFailure({
            candidate,
            groupKey: group.groupKey,
            stage: "dm_send",
            error: err,
            releaseCandidate: this.deps.releaseCandidate,
          });
          group.failedByUserId.set(discordUserId, failure);
        }
      }

      for (const group of groups.values()) {
        if (group.sentByUserId.size === 0 && group.failedByUserId.size === 0) {
          continue;
        }
        const leaderChannel = await this.deps.resolveLeaderChannel({
          client: this.client,
          clanTag: group.clanTag,
        });
        if (!leaderChannel) {
          logFailed += 1;
          dozzleLog.warn(
            `[fwa base-swap dm-reminder] leader_log_skipped group=${group.groupKey} reason=no_leader_channel clan=${group.clanTag}`,
          );
          continue;
        }

        const clanName = leaderChannel.clanName ?? group.clanName ?? "Unknown Clan";
        const content = buildLeaderChannelLogContent({
          ...group,
          clanName,
        });
        try {
          await leaderChannel.send({
            content,
            allowedMentions: { parse: [] },
          });
          dozzleLog.info(
            `[fwa base-swap dm-reminder] leader_log_sent group=${group.groupKey} sent=${group.sentByUserId.size} failed=${group.failedByUserId.size} deduped=${group.dedupedCount}`,
          );
        } catch (err) {
          logFailed += 1;
          dozzleLog.error(
            `[fwa base-swap dm-reminder] leader_log_failed group=${group.groupKey} error=${formatError(err)}`,
          );
        }
      }

      dozzleLog.debug(
        `[fwa base-swap dm-reminder] cycle_complete evaluated=${evaluated} sent=${sent} deduped=${deduped} failed=${failed} logFailed=${logFailed}`,
      );
      return { evaluated, sent, deduped, failed, logFailed };
    } catch (err) {
      dozzleLog.error(
        `[fwa base-swap dm-reminder] cycle_failed error=${formatError(err)}`,
      );
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  private async findCandidatesByGuild(
    nowMs: number,
  ): Promise<FwaBaseSwapDmReminderCandidate[][]> {
    const guildIds = [
      ...new Set(
        (
          await prisma.trackedMessage.findMany({
            where: {
              featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
              status: TRACKED_MESSAGE_STATUS.ACTIVE,
              expiresAt: { gt: new Date(nowMs) },
            },
            select: { guildId: true },
          })
        )
          .map((row) => String(row.guildId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (guildIds.length === 0) return [];

    const groups: FwaBaseSwapDmReminderCandidate[][] = [];
    for (const guildId of guildIds) {
      const candidates = await this.deps.findPendingCandidates({
        guildId,
        now: new Date(nowMs),
      });
      if (candidates.length > 0) {
        groups.push(candidates);
      }
    }
    return groups;
  }
}
