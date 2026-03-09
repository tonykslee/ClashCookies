import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { getTelemetryContext } from "./context";
import { classifyTelemetryError, type TelemetryErrorCategory } from "./errorTaxonomy";

type CommandLifecycleStatus = "start" | "success" | "failure";
type StageStatus = "success" | "failure";
type ApiStatus = "success" | "failure";

type CommandLifecycleEvent = {
  status: CommandLifecycleStatus;
  guildId?: string | null;
  userId?: string | null;
  commandName?: string | null;
  subcommand?: string | null;
  runId?: string | null;
  interactionId?: string | null;
  durationMs?: number | null;
  errorCategory?: TelemetryErrorCategory | string | null;
  errorCode?: string | null;
  timeout?: boolean | null;
};

type StageTimingEvent = {
  stage: string;
  status: StageStatus;
  guildId?: string | null;
  commandName?: string | null;
  subcommand?: string | null;
  runId?: string | null;
  durationMs: number;
};

type ApiTimingEvent = {
  namespace: string;
  operation: string;
  source: "api" | "web" | "cache_hit" | "cache_miss" | "fallback_cache";
  status?: ApiStatus;
  guildId?: string | null;
  commandName?: string | null;
  durationMs?: number | null;
  errorCategory?: TelemetryErrorCategory | string | null;
  errorCode?: string | null;
  timeout?: boolean | null;
};

type CommandRollup = {
  key: string;
  bucketStart: Date;
  guildId: string;
  commandName: string;
  subcommand: string;
  status: "success" | "failure";
  count: number;
  errorCount: number;
  timeoutCount: number;
  totalDurationMs: bigint;
  maxDurationMs: number;
  minDurationMs: number | null;
  latencyLt250: number;
  latencyLt1000: number;
  latencyLt3000: number;
  latencyLt10000: number;
  latencyGte10000: number;
};

type UserRollup = {
  key: string;
  bucketStart: Date;
  guildId: string;
  userId: string;
  commandName: string;
  subcommand: string;
  count: number;
  failureCount: number;
  timeoutCount: number;
  totalDurationMs: bigint;
  maxDurationMs: number;
};

type ApiRollup = {
  key: string;
  bucketStart: Date;
  guildId: string;
  commandName: string;
  namespace: string;
  operation: string;
  source: string;
  status: ApiStatus;
  errorCategory: string;
  errorCode: string;
  count: number;
  errorCount: number;
  timeoutCount: number;
  totalDurationMs: bigint;
  maxDurationMs: number;
};

type StageRollup = {
  key: string;
  bucketStart: Date;
  guildId: string;
  commandName: string;
  subcommand: string;
  stage: string;
  status: StageStatus;
  count: number;
  totalDurationMs: bigint;
  maxDurationMs: number;
};

type FetchEventLike = {
  namespace: string;
  operation: string;
  source: "api" | "web" | "cache_hit" | "cache_miss" | "fallback_cache";
  detail?: string;
  durationMs?: number | null;
  status?: ApiStatus;
  errorCategory?: string | null;
  errorCode?: string | null;
  timeout?: boolean | null;
};

function toHourBucket(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      0,
      0,
      0
    )
  );
}

function normalizeDurationMs(input: number | null | undefined): number {
  if (!Number.isFinite(input ?? NaN)) return 0;
  return Math.max(0, Math.trunc(input as number));
}

function normalizeSubcommand(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 64) : "";
}

function normalizeCommand(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 64) : "unknown";
}

function normalizeGuildId(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text || "global";
}

function normalizeUserId(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text || "unknown";
}

function durationToBigInt(durationMs: number): bigint {
  return BigInt(normalizeDurationMs(durationMs));
}

function classifyLatency(durationMs: number): {
  lt250: number;
  lt1000: number;
  lt3000: number;
  lt10000: number;
  gte10000: number;
} {
  const d = normalizeDurationMs(durationMs);
  if (d < 250) return { lt250: 1, lt1000: 0, lt3000: 0, lt10000: 0, gte10000: 0 };
  if (d < 1000) return { lt250: 0, lt1000: 1, lt3000: 0, lt10000: 0, gte10000: 0 };
  if (d < 3000) return { lt250: 0, lt1000: 0, lt3000: 1, lt10000: 0, gte10000: 0 };
  if (d < 10000) return { lt250: 0, lt1000: 0, lt3000: 0, lt10000: 1, gte10000: 0 };
  return { lt250: 0, lt1000: 0, lt3000: 0, lt10000: 0, gte10000: 1 };
}

function coerceApiStatus(status: ApiStatus | undefined, hasFailureSignals: boolean): ApiStatus {
  if (status === "success" || status === "failure") return status;
  return hasFailureSignals ? "failure" : "success";
}

function mergeCommandRollup(target: CommandRollup, source: CommandRollup): void {
  target.count += source.count;
  target.errorCount += source.errorCount;
  target.timeoutCount += source.timeoutCount;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
  if (source.minDurationMs !== null) {
    target.minDurationMs =
      target.minDurationMs === null ? source.minDurationMs : Math.min(target.minDurationMs, source.minDurationMs);
  }
  target.latencyLt250 += source.latencyLt250;
  target.latencyLt1000 += source.latencyLt1000;
  target.latencyLt3000 += source.latencyLt3000;
  target.latencyLt10000 += source.latencyLt10000;
  target.latencyGte10000 += source.latencyGte10000;
}

function mergeUserRollup(target: UserRollup, source: UserRollup): void {
  target.count += source.count;
  target.failureCount += source.failureCount;
  target.timeoutCount += source.timeoutCount;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
}

function mergeApiRollup(target: ApiRollup, source: ApiRollup): void {
  target.count += source.count;
  target.errorCount += source.errorCount;
  target.timeoutCount += source.timeoutCount;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
}

function mergeStageRollup(target: StageRollup, source: StageRollup): void {
  target.count += source.count;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
}

function mergeMapValues<T extends { key: string }>(
  target: Map<string, T>,
  source: Map<string, T>,
  merge: (targetValue: T, sourceValue: T) => void
): void {
  for (const [key, sourceValue] of source.entries()) {
    const existing = target.get(key);
    if (!existing) {
      target.set(key, sourceValue);
      continue;
    }
    merge(existing, sourceValue);
  }
}

export class TelemetryIngestService {
  private static singleton: TelemetryIngestService | null = null;

  private commandRollups = new Map<string, CommandRollup>();
  private userRollups = new Map<string, UserRollup>();
  private apiRollups = new Map<string, ApiRollup>();
  private stageRollups = new Map<string, StageRollup>();
  private sampleCounters = new Map<string, number>();
  private flushIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private flushInProgress = false;

  private readonly flushIntervalMs = Math.max(
    10_000,
    Number(process.env.TELEMETRY_FLUSH_INTERVAL_MS ?? 60_000)
  );
  private readonly sampleEvery = Math.max(
    1,
    Number(process.env.TELEMETRY_SUCCESS_LOG_SAMPLE_EVERY ?? 20)
  );

  /** Purpose: get a process-wide telemetry ingest singleton. */
  static getInstance(): TelemetryIngestService {
    if (!TelemetryIngestService.singleton) {
      TelemetryIngestService.singleton = new TelemetryIngestService();
    }
    return TelemetryIngestService.singleton;
  }

  /** Purpose: begin periodic aggregate flushes from in-memory rollups to the database. */
  startAutoFlush(): void {
    if (this.flushIntervalHandle) return;
    this.flushIntervalHandle = setInterval(() => {
      this.flush().catch((err) => {
        console.error(`[telemetry-v2] flush failed error=${String((err as Error)?.message ?? err)}`);
      });
    }, this.flushIntervalMs);
  }

  /** Purpose: stop periodic flushes (primarily for tests/shutdown control). */
  stopAutoFlush(): void {
    if (!this.flushIntervalHandle) return;
    clearInterval(this.flushIntervalHandle);
    this.flushIntervalHandle = null;
  }

  /** Purpose: record command start/success/failure lifecycle events and aggregate command/user metrics. */
  recordCommandLifecycle(input: CommandLifecycleEvent): void {
    const context = getTelemetryContext();
    const guildId = normalizeGuildId(input.guildId ?? context?.guildId ?? null);
    const userId = normalizeUserId(input.userId ?? context?.userId ?? null);
    const commandName = normalizeCommand(input.commandName ?? context?.commandName ?? null);
    const subcommand = normalizeSubcommand(input.subcommand ?? context?.subcommand ?? null);
    const durationMs = normalizeDurationMs(input.durationMs);
    const status = input.status;
    const errorCategory = String(input.errorCategory ?? "").trim();
    const errorCode = String(input.errorCode ?? "").trim();
    const timeout = Boolean(input.timeout);

    this.logEventSampled(
      `command:${commandName}:${subcommand}:${status}`,
      {
        kind: "command_lifecycle",
        status,
        guildId,
        userId,
        command: commandName,
        subcommand,
        durationMs,
        runId: input.runId ?? context?.runId ?? "",
        interactionId: input.interactionId ?? context?.interactionId ?? "",
        errorCategory,
        errorCode,
        timeout,
      },
      status === "failure" || status === "start"
    );

    if (status === "start") return;
    const bucketStart = toHourBucket(new Date());
    const isFailure = status === "failure";
    const latency = classifyLatency(durationMs);
    const key = [
      bucketStart.toISOString(),
      guildId,
      commandName,
      subcommand,
      status,
    ].join("|");
    const existing = this.commandRollups.get(key);
    if (existing) {
      existing.count += 1;
      existing.errorCount += isFailure ? 1 : 0;
      existing.timeoutCount += timeout ? 1 : 0;
      existing.totalDurationMs += durationToBigInt(durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.minDurationMs =
        existing.minDurationMs === null ? durationMs : Math.min(existing.minDurationMs, durationMs);
      existing.latencyLt250 += latency.lt250;
      existing.latencyLt1000 += latency.lt1000;
      existing.latencyLt3000 += latency.lt3000;
      existing.latencyLt10000 += latency.lt10000;
      existing.latencyGte10000 += latency.gte10000;
    } else {
      this.commandRollups.set(key, {
        key,
        bucketStart,
        guildId,
        commandName,
        subcommand,
        status,
        count: 1,
        errorCount: isFailure ? 1 : 0,
        timeoutCount: timeout ? 1 : 0,
        totalDurationMs: durationToBigInt(durationMs),
        maxDurationMs: durationMs,
        minDurationMs: durationMs,
        latencyLt250: latency.lt250,
        latencyLt1000: latency.lt1000,
        latencyLt3000: latency.lt3000,
        latencyLt10000: latency.lt10000,
        latencyGte10000: latency.gte10000,
      });
    }

    const userKey = [
      bucketStart.toISOString(),
      guildId,
      userId,
      commandName,
      subcommand,
    ].join("|");
    const existingUser = this.userRollups.get(userKey);
    if (existingUser) {
      existingUser.count += 1;
      existingUser.failureCount += isFailure ? 1 : 0;
      existingUser.timeoutCount += timeout ? 1 : 0;
      existingUser.totalDurationMs += durationToBigInt(durationMs);
      existingUser.maxDurationMs = Math.max(existingUser.maxDurationMs, durationMs);
    } else {
      this.userRollups.set(userKey, {
        key: userKey,
        bucketStart,
        guildId,
        userId,
        commandName,
        subcommand,
        count: 1,
        failureCount: isFailure ? 1 : 0,
        timeoutCount: timeout ? 1 : 0,
        totalDurationMs: durationToBigInt(durationMs),
        maxDurationMs: durationMs,
      });
    }
  }

  /** Purpose: record stage timing samples for bottleneck/congestion reporting. */
  recordStageTiming(input: StageTimingEvent): void {
    const context = getTelemetryContext();
    const bucketStart = toHourBucket(new Date());
    const guildId = normalizeGuildId(input.guildId ?? context?.guildId ?? null);
    const commandName = normalizeCommand(input.commandName ?? context?.commandName ?? null);
    const subcommand = normalizeSubcommand(input.subcommand ?? context?.subcommand ?? null);
    const stage = String(input.stage ?? "").trim().slice(0, 64) || "unknown_stage";
    const durationMs = normalizeDurationMs(input.durationMs);
    const status = input.status;
    const key = [
      bucketStart.toISOString(),
      guildId,
      commandName,
      subcommand,
      stage,
      status,
    ].join("|");

    this.logEventSampled(
      `stage:${commandName}:${subcommand}:${stage}:${status}`,
      {
        kind: "command_stage",
        status,
        stage,
        guildId,
        command: commandName,
        subcommand,
        durationMs,
        runId: input.runId ?? context?.runId ?? "",
      },
      status === "failure" || durationMs >= 5000
    );

    const existing = this.stageRollups.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalDurationMs += durationToBigInt(durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
    } else {
      this.stageRollups.set(key, {
        key,
        bucketStart,
        guildId,
        commandName,
        subcommand,
        stage,
        status,
        count: 1,
        totalDurationMs: durationToBigInt(durationMs),
        maxDurationMs: durationMs,
      });
    }
  }

  /** Purpose: record API/cache timing samples and aggregate API behavior metrics. */
  recordApiTiming(input: ApiTimingEvent): void {
    const context = getTelemetryContext();
    const durationMs = normalizeDurationMs(input.durationMs);
    const timeout = Boolean(input.timeout);
    const errorCategory = String(input.errorCategory ?? "").trim();
    const errorCode = String(input.errorCode ?? "").trim();
    const hasFailureSignals = timeout || !!errorCategory || !!errorCode;
    const status = coerceApiStatus(input.status, hasFailureSignals);
    const bucketStart = toHourBucket(new Date());
    const guildId = normalizeGuildId(input.guildId ?? context?.guildId ?? null);
    const commandName = normalizeSubcommand(input.commandName ?? context?.commandName ?? "");
    const namespace = String(input.namespace ?? "").trim().slice(0, 64) || "unknown_namespace";
    const operation = String(input.operation ?? "").trim().slice(0, 64) || "unknown_operation";
    const source = String(input.source ?? "").trim().slice(0, 32) || "unknown_source";
    const errorCount = status === "failure" ? 1 : 0;

    this.logEventSampled(
      `api:${namespace}:${operation}:${source}:${status}`,
      {
        kind: "api_call",
        status,
        guildId,
        command: commandName,
        namespace,
        operation,
        source,
        durationMs,
        errorCategory,
        errorCode,
        timeout,
      },
      status === "failure" || timeout
    );

    const key = [
      bucketStart.toISOString(),
      guildId,
      commandName,
      namespace,
      operation,
      source,
      status,
      errorCategory,
      errorCode,
    ].join("|");
    const existing = this.apiRollups.get(key);
    if (existing) {
      existing.count += 1;
      existing.errorCount += errorCount;
      existing.timeoutCount += timeout ? 1 : 0;
      existing.totalDurationMs += durationToBigInt(durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
    } else {
      this.apiRollups.set(key, {
        key,
        bucketStart,
        guildId,
        commandName,
        namespace,
        operation,
        source,
        status,
        errorCategory,
        errorCode,
        count: 1,
        errorCount,
        timeoutCount: timeout ? 1 : 0,
        totalDurationMs: durationToBigInt(durationMs),
        maxDurationMs: durationMs,
      });
    }
  }

  /** Purpose: record an existing fetch telemetry event while preserving compatibility with legacy callers. */
  recordFetchEventTelemetry(event: FetchEventLike): void {
    const fallbackErrorCategory =
      String(event.errorCategory ?? "").trim() ||
      (event.status === "failure" ? "upstream_api" : "");
    const fallbackErrorCode = String(event.errorCode ?? "").trim();
    const inferredStatus: ApiStatus =
      event.status ??
      (fallbackErrorCategory || fallbackErrorCode || event.timeout ? "failure" : "success");
    this.recordApiTiming({
      namespace: event.namespace,
      operation: event.operation,
      source: event.source,
      durationMs: event.durationMs ?? 0,
      status: inferredStatus,
      errorCategory: fallbackErrorCategory,
      errorCode: fallbackErrorCode,
      timeout: event.timeout ?? false,
    });
  }

  /** Purpose: force-flush all pending in-memory telemetry aggregates to PostgreSQL. */
  async flush(): Promise<void> {
    if (this.flushInProgress) return;
    this.flushInProgress = true;
    const commandMap = this.commandRollups;
    const userMap = this.userRollups;
    const apiMap = this.apiRollups;
    const stageMap = this.stageRollups;
    this.commandRollups = new Map();
    this.userRollups = new Map();
    this.apiRollups = new Map();
    this.stageRollups = new Map();

    try {
      await this.persistCommandRollups([...commandMap.values()]);
      await this.persistUserRollups([...userMap.values()]);
      await this.persistApiRollups([...apiMap.values()]);
      await this.persistStageRollups([...stageMap.values()]);
    } catch (err) {
      console.error(`[telemetry-v2] flush persist failed error=${String((err as Error)?.message ?? err)}`);
      mergeMapValues(this.commandRollups, commandMap, mergeCommandRollup);
      mergeMapValues(this.userRollups, userMap, mergeUserRollup);
      mergeMapValues(this.apiRollups, apiMap, mergeApiRollup);
      mergeMapValues(this.stageRollups, stageMap, mergeStageRollup);
    } finally {
      this.flushInProgress = false;
    }
  }

  private logEventSampled(key: string, payload: Record<string, unknown>, forceLog: boolean): void {
    const nextCount = (this.sampleCounters.get(key) ?? 0) + 1;
    this.sampleCounters.set(key, nextCount);
    if (!forceLog && nextCount % this.sampleEvery !== 0) return;
    const enriched = {
      ts: new Date().toISOString(),
      ...payload,
      sampleCount: nextCount,
    };
    console.info(`[telemetry-v2] ${JSON.stringify(enriched)}`);
  }

  private async persistCommandRollups(rows: CommandRollup[]): Promise<void> {
    for (const row of rows) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "TelemetryCommandAggregate"
            (
              "id",
              "bucketStart",
              "guildId",
              "commandName",
              "subcommand",
              "status",
              "count",
              "errorCount",
              "timeoutCount",
              "totalDurationMs",
              "maxDurationMs",
              "minDurationMs",
              "latencyLt250",
              "latencyLt1000",
              "latencyLt3000",
              "latencyLt10000",
              "latencyGte10000",
              "createdAt",
              "updatedAt"
            )
          VALUES
            (
              ${randomUUID()},
              ${row.bucketStart},
              ${row.guildId},
              ${row.commandName},
              ${row.subcommand},
              ${row.status},
              ${row.count},
              ${row.errorCount},
              ${row.timeoutCount},
              ${row.totalDurationMs},
              ${row.maxDurationMs},
              ${row.minDurationMs},
              ${row.latencyLt250},
              ${row.latencyLt1000},
              ${row.latencyLt3000},
              ${row.latencyLt10000},
              ${row.latencyGte10000},
              NOW(),
              NOW()
            )
          ON CONFLICT ("bucketStart", "guildId", "commandName", "subcommand", "status")
          DO UPDATE SET
            "count" = "TelemetryCommandAggregate"."count" + EXCLUDED."count",
            "errorCount" = "TelemetryCommandAggregate"."errorCount" + EXCLUDED."errorCount",
            "timeoutCount" = "TelemetryCommandAggregate"."timeoutCount" + EXCLUDED."timeoutCount",
            "totalDurationMs" = "TelemetryCommandAggregate"."totalDurationMs" + EXCLUDED."totalDurationMs",
            "maxDurationMs" = GREATEST("TelemetryCommandAggregate"."maxDurationMs", EXCLUDED."maxDurationMs"),
            "minDurationMs" = CASE
              WHEN "TelemetryCommandAggregate"."minDurationMs" IS NULL THEN EXCLUDED."minDurationMs"
              WHEN EXCLUDED."minDurationMs" IS NULL THEN "TelemetryCommandAggregate"."minDurationMs"
              ELSE LEAST("TelemetryCommandAggregate"."minDurationMs", EXCLUDED."minDurationMs")
            END,
            "latencyLt250" = "TelemetryCommandAggregate"."latencyLt250" + EXCLUDED."latencyLt250",
            "latencyLt1000" = "TelemetryCommandAggregate"."latencyLt1000" + EXCLUDED."latencyLt1000",
            "latencyLt3000" = "TelemetryCommandAggregate"."latencyLt3000" + EXCLUDED."latencyLt3000",
            "latencyLt10000" = "TelemetryCommandAggregate"."latencyLt10000" + EXCLUDED."latencyLt10000",
            "latencyGte10000" = "TelemetryCommandAggregate"."latencyGte10000" + EXCLUDED."latencyGte10000",
            "updatedAt" = NOW()
        `
      );
    }
  }

  private async persistUserRollups(rows: UserRollup[]): Promise<void> {
    for (const row of rows) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "TelemetryUserCommandAggregate"
            (
              "id",
              "bucketStart",
              "guildId",
              "userId",
              "commandName",
              "subcommand",
              "count",
              "failureCount",
              "timeoutCount",
              "totalDurationMs",
              "maxDurationMs",
              "createdAt",
              "updatedAt"
            )
          VALUES
            (
              ${randomUUID()},
              ${row.bucketStart},
              ${row.guildId},
              ${row.userId},
              ${row.commandName},
              ${row.subcommand},
              ${row.count},
              ${row.failureCount},
              ${row.timeoutCount},
              ${row.totalDurationMs},
              ${row.maxDurationMs},
              NOW(),
              NOW()
            )
          ON CONFLICT ("bucketStart", "guildId", "userId", "commandName", "subcommand")
          DO UPDATE SET
            "count" = "TelemetryUserCommandAggregate"."count" + EXCLUDED."count",
            "failureCount" = "TelemetryUserCommandAggregate"."failureCount" + EXCLUDED."failureCount",
            "timeoutCount" = "TelemetryUserCommandAggregate"."timeoutCount" + EXCLUDED."timeoutCount",
            "totalDurationMs" = "TelemetryUserCommandAggregate"."totalDurationMs" + EXCLUDED."totalDurationMs",
            "maxDurationMs" = GREATEST("TelemetryUserCommandAggregate"."maxDurationMs", EXCLUDED."maxDurationMs"),
            "updatedAt" = NOW()
        `
      );
    }
  }

  private async persistApiRollups(rows: ApiRollup[]): Promise<void> {
    for (const row of rows) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "TelemetryApiAggregate"
            (
              "id",
              "bucketStart",
              "guildId",
              "commandName",
              "namespace",
              "operation",
              "source",
              "status",
              "errorCategory",
              "errorCode",
              "count",
              "errorCount",
              "timeoutCount",
              "totalDurationMs",
              "maxDurationMs",
              "createdAt",
              "updatedAt"
            )
          VALUES
            (
              ${randomUUID()},
              ${row.bucketStart},
              ${row.guildId},
              ${row.commandName},
              ${row.namespace},
              ${row.operation},
              ${row.source},
              ${row.status},
              ${row.errorCategory},
              ${row.errorCode},
              ${row.count},
              ${row.errorCount},
              ${row.timeoutCount},
              ${row.totalDurationMs},
              ${row.maxDurationMs},
              NOW(),
              NOW()
            )
          ON CONFLICT ("bucketStart", "guildId", "commandName", "namespace", "operation", "source", "status", "errorCategory", "errorCode")
          DO UPDATE SET
            "count" = "TelemetryApiAggregate"."count" + EXCLUDED."count",
            "errorCount" = "TelemetryApiAggregate"."errorCount" + EXCLUDED."errorCount",
            "timeoutCount" = "TelemetryApiAggregate"."timeoutCount" + EXCLUDED."timeoutCount",
            "totalDurationMs" = "TelemetryApiAggregate"."totalDurationMs" + EXCLUDED."totalDurationMs",
            "maxDurationMs" = GREATEST("TelemetryApiAggregate"."maxDurationMs", EXCLUDED."maxDurationMs"),
            "updatedAt" = NOW()
        `
      );
    }
  }

  private async persistStageRollups(rows: StageRollup[]): Promise<void> {
    for (const row of rows) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "TelemetryStageAggregate"
            (
              "id",
              "bucketStart",
              "guildId",
              "commandName",
              "subcommand",
              "stage",
              "status",
              "count",
              "totalDurationMs",
              "maxDurationMs",
              "createdAt",
              "updatedAt"
            )
          VALUES
            (
              ${randomUUID()},
              ${row.bucketStart},
              ${row.guildId},
              ${row.commandName},
              ${row.subcommand},
              ${row.stage},
              ${row.status},
              ${row.count},
              ${row.totalDurationMs},
              ${row.maxDurationMs},
              NOW(),
              NOW()
            )
          ON CONFLICT ("bucketStart", "guildId", "commandName", "subcommand", "stage", "status")
          DO UPDATE SET
            "count" = "TelemetryStageAggregate"."count" + EXCLUDED."count",
            "totalDurationMs" = "TelemetryStageAggregate"."totalDurationMs" + EXCLUDED."totalDurationMs",
            "maxDurationMs" = GREATEST("TelemetryStageAggregate"."maxDurationMs", EXCLUDED."maxDurationMs"),
            "updatedAt" = NOW()
        `
      );
    }
  }
}

/** Purpose: build failure telemetry metadata from any thrown error. */
export function toFailureTelemetry(error: unknown): {
  errorCategory: TelemetryErrorCategory;
  errorCode: string;
  timeout: boolean;
} {
  const classified = classifyTelemetryError(error);
  return {
    errorCategory: classified.category,
    errorCode: classified.code,
    timeout: classified.timeout,
  };
}
