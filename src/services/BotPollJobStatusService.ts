import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";

export type BotPollJobStatusRecord = {
  jobKey: string;
  displayName: string;
  enabled: boolean;
  status: string;
  intervalMs: number | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  nextDueAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  runCount: number;
  failureCount: number;
  metadata: Prisma.JsonValue | null;
  updatedAt: Date;
};

export type BotPollJobStatusInput = {
  displayName: string;
  enabled?: boolean;
  intervalMs?: number | null;
  nextDueAt?: Date | null;
  metadata?: Prisma.InputJsonValue | null;
};

const MAX_ERROR_LENGTH = 900;

function normalizeIntervalMs(input: number | null | undefined): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  const value = Math.trunc(input);
  return value > 0 ? value : null;
}

function truncateErrorText(input: unknown): string {
  const text = formatError(input).trim();
  if (text.length <= MAX_ERROR_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_LENGTH - 12)}...truncated`;
}

function buildBaseWrite(input: BotPollJobStatusInput) {
  return {
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    intervalMs: normalizeIntervalMs(input.intervalMs),
    nextDueAt: input.nextDueAt ?? null,
    metadata: input.metadata ?? Prisma.DbNull,
  };
}

/** Purpose: persist and query background poll job status rows for read-only dashboards. */
export class BotPollJobStatusService {
  async markStarted(
    jobKey: string,
    input: BotPollJobStatusInput,
  ): Promise<BotPollJobStatusRecord> {
    const startedAt = new Date();
    return (await prisma.botPollJobStatus.upsert({
      where: { jobKey },
      create: {
        jobKey,
        ...buildBaseWrite(input),
        status: "running",
        lastStartedAt: startedAt,
        runCount: 1,
        failureCount: 0,
      },
      update: {
        ...buildBaseWrite(input),
        status: "running",
        lastStartedAt: startedAt,
        runCount: { increment: 1 },
      },
    })) as BotPollJobStatusRecord;
  }

  async markSucceeded(
    jobKey: string,
    input: BotPollJobStatusInput,
  ): Promise<BotPollJobStatusRecord> {
    const finishedAt = new Date();
    return (await prisma.botPollJobStatus.upsert({
      where: { jobKey },
      create: {
        jobKey,
        ...buildBaseWrite(input),
        status: "idle",
        lastFinishedAt: finishedAt,
      },
      update: {
        ...buildBaseWrite(input),
        status: "idle",
        lastFinishedAt: finishedAt,
      },
    })) as BotPollJobStatusRecord;
  }

  async markFailed(
    jobKey: string,
    error: unknown,
    input: BotPollJobStatusInput,
  ): Promise<BotPollJobStatusRecord> {
    const finishedAt = new Date();
    const lastError = truncateErrorText(error);
    return (await prisma.botPollJobStatus.upsert({
      where: { jobKey },
      create: {
        jobKey,
        ...buildBaseWrite(input),
        status: "failed",
        lastFinishedAt: finishedAt,
        lastErrorAt: finishedAt,
        lastError,
        failureCount: 1,
      },
      update: {
        ...buildBaseWrite(input),
        status: "failed",
        lastFinishedAt: finishedAt,
        lastErrorAt: finishedAt,
        lastError,
        failureCount: { increment: 1 },
      },
    })) as BotPollJobStatusRecord;
  }

  async markSkipped(
    jobKey: string,
    input: BotPollJobStatusInput,
  ): Promise<BotPollJobStatusRecord> {
    const finishedAt = new Date();
    return (await prisma.botPollJobStatus.upsert({
      where: { jobKey },
      create: {
        jobKey,
        ...buildBaseWrite(input),
        status: "skipped",
        lastFinishedAt: finishedAt,
      },
      update: {
        ...buildBaseWrite(input),
        status: "skipped",
        lastFinishedAt: finishedAt,
      },
    })) as BotPollJobStatusRecord;
  }

  async markDisabled(
    jobKey: string,
    input: BotPollJobStatusInput,
  ): Promise<BotPollJobStatusRecord> {
    return (await prisma.botPollJobStatus.upsert({
      where: { jobKey },
      create: {
        jobKey,
        ...buildBaseWrite({ ...input, enabled: false }),
        status: "disabled",
      },
      update: {
        ...buildBaseWrite({ ...input, enabled: false }),
        status: "disabled",
      },
    })) as BotPollJobStatusRecord;
  }

  async listStatuses(): Promise<BotPollJobStatusRecord[]> {
    return (await prisma.botPollJobStatus.findMany({
      orderBy: [{ displayName: "asc" }, { jobKey: "asc" }],
    })) as BotPollJobStatusRecord[];
  }

  async getStatus(jobKey: string): Promise<BotPollJobStatusRecord | null> {
    return (await prisma.botPollJobStatus.findUnique({
      where: { jobKey },
    })) as BotPollJobStatusRecord | null;
  }
}

export const botPollJobStatusService = new BotPollJobStatusService();
