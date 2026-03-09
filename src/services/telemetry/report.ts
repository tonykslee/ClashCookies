import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { COMMAND_PERMISSION_TARGETS } from "../CommandPermissionService";
import { formatDateInTimeZone } from "./timeWindow";

export type TelemetryPeriod = "24h" | "7d" | "30d";

type CommandRollupRow = {
  commandName: string;
  totalCount: bigint;
  failureCount: bigint;
  timeoutCount: bigint;
  totalDurationMs: bigint;
  maxDurationMs: number;
  lt250: bigint;
  lt1000: bigint;
  lt3000: bigint;
  lt10000: bigint;
  gte10000: bigint;
};

type UserRollupRow = {
  userId: string;
  totalCount: bigint;
  failureCount: bigint;
};

type ApiSummaryRow = {
  totalCount: bigint;
  errorCount: bigint;
  timeoutCount: bigint;
};

type StageSummaryRow = {
  stage: string;
  totalCount: bigint;
  totalDurationMs: bigint;
  maxDurationMs: number;
};

type HourSummaryRow = {
  bucketStart: Date;
  totalCount: bigint;
};

type DaySummaryRow = {
  dayBucket: Date;
  totalCount: bigint;
};

export type TelemetryReport = {
  periodLabel: string;
  timeZone: string;
  start: Date;
  end: Date;
  totalCommands: number;
  failedCommands: number;
  timeoutCount: number;
  failureRatePct: number;
  uniqueUsers: number;
  apiCalls: number;
  apiErrors: number;
  apiTimeouts: number;
  apiErrorRatePct: number;
  topCommands: Array<{
    commandName: string;
    totalCount: number;
    failureRatePct: number;
    avgDurationMs: number;
    maxDurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
  }>;
  failedCommandRows: Array<{ commandName: string; failureCount: number; totalCount: number }>;
  slowestCommands: Array<{ commandName: string; maxDurationMs: number; avgDurationMs: number }>;
  leastUsedCommands: Array<{ commandName: string; totalCount: number }>;
  mostActiveUsers: Array<{ userId: string; totalCount: number; failureCount: number }>;
  busiestHour: { label: string; totalCount: number } | null;
  busiestDay: { label: string; totalCount: number } | null;
  hottestStages: Array<{ stage: string; avgDurationMs: number; maxDurationMs: number; totalCount: number }>;
};

/** Purpose: render telemetry report summary as compact Discord message content. */
export function renderTelemetryReport(report: TelemetryReport): string {
  const header = [
    `# Telemetry Report (${report.periodLabel})`,
    `Window: ${formatDateInTimeZone(report.start, report.timeZone)} -> ${formatDateInTimeZone(
      report.end,
      report.timeZone
    )} (${report.timeZone})`,
    `Commands: **${report.totalCommands}** | Failures: **${report.failedCommands}** (${report.failureRatePct.toFixed(
      1
    )}%) | Timeouts: **${report.timeoutCount}**`,
    `Unique users: **${report.uniqueUsers}**`,
    `API calls: **${report.apiCalls}** | API errors: **${report.apiErrors}** (${report.apiErrorRatePct.toFixed(
      1
    )}%) | API timeouts: **${report.apiTimeouts}**`,
  ];

  const sections: string[] = [];
  sections.push(
    "## Top Commands",
    ...(report.topCommands.length > 0
      ? report.topCommands.map(
          (row, index) =>
            `${index + 1}. \`/${row.commandName}\` ${row.totalCount} calls | avg ${row.avgDurationMs}ms | p95~${row.p95DurationMs}ms | p99~${row.p99DurationMs}ms | fail ${row.failureRatePct.toFixed(
              1
            )}%`
        )
      : ["- No command data yet."])
  );

  sections.push(
    "## Longest Response Times",
    ...(report.slowestCommands.length > 0
      ? report.slowestCommands.map(
          (row, index) =>
            `${index + 1}. \`/${row.commandName}\` max ${row.maxDurationMs}ms | avg ${row.avgDurationMs}ms`
        )
      : ["- No latency data yet."])
  );

  sections.push(
    "## Most Active Users",
    ...(report.mostActiveUsers.length > 0
      ? report.mostActiveUsers.map(
          (row, index) =>
            `${index + 1}. <@${row.userId}> ${row.totalCount} commands | failures ${row.failureCount}`
        )
      : ["- No user activity yet."])
  );

  sections.push(
    "## Failed Commands",
    ...(report.failedCommandRows.length > 0
      ? report.failedCommandRows.map(
          (row, index) =>
            `${index + 1}. \`/${row.commandName}\` ${row.failureCount}/${row.totalCount} failed`
        )
      : ["- No command failures."])
  );

  sections.push(
    "## Least Used Commands",
    ...report.leastUsedCommands.map(
      (row, index) => `${index + 1}. \`/${row.commandName}\` ${row.totalCount} calls`
    )
  );

  const peakLines: string[] = [];
  if (report.busiestHour) {
    peakLines.push(`- Busiest hour: ${report.busiestHour.label} (${report.busiestHour.totalCount} calls)`);
  }
  if (report.busiestDay) {
    peakLines.push(`- Busiest day: ${report.busiestDay.label} (${report.busiestDay.totalCount} calls)`);
  }
  sections.push("## Peaks", ...(peakLines.length > 0 ? peakLines : ["- No peak data yet."]));

  sections.push(
    "## Stage Hotspots",
    ...(report.hottestStages.length > 0
      ? report.hottestStages.map(
          (row, index) =>
            `${index + 1}. \`${row.stage}\` avg ${row.avgDurationMs}ms | max ${row.maxDurationMs}ms | samples ${row.totalCount}`
        )
      : ["- No stage timing samples yet."])
  );

  return [...header, "", ...sections].join("\n");
}

function toNumber(value: bigint | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function getPeriodHours(period: TelemetryPeriod): number {
  if (period === "24h") return 24;
  if (period === "7d") return 7 * 24;
  return 30 * 24;
}

/** Purpose: parse report period option into a supported fixed window enum. */
export function parseTelemetryPeriod(input: string | null | undefined): TelemetryPeriod {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "24h" || value === "7d" || value === "30d") return value;
  return "24h";
}

/** Purpose: estimate percentile latency from aggregate histogram buckets. */
export function estimatePercentileFromBuckets(input: {
  lt250: number;
  lt1000: number;
  lt3000: number;
  lt10000: number;
  gte10000: number;
  percentile: number;
}): number {
  const p = Math.min(0.999, Math.max(0.5, input.percentile));
  const total = input.lt250 + input.lt1000 + input.lt3000 + input.lt10000 + input.gte10000;
  if (total <= 0) return 0;
  const target = Math.ceil(total * p);
  const buckets: Array<{ count: number; min: number; max: number }> = [
    { count: input.lt250, min: 0, max: 250 },
    { count: input.lt1000, min: 250, max: 1000 },
    { count: input.lt3000, min: 1000, max: 3000 },
    { count: input.lt10000, min: 3000, max: 10000 },
    { count: input.gte10000, min: 10000, max: 30000 },
  ];
  let cumulative = 0;
  for (const bucket of buckets) {
    if (bucket.count <= 0) continue;
    const previous = cumulative;
    cumulative += bucket.count;
    if (cumulative < target) continue;
    const position = target - previous;
    const ratio = Math.min(1, Math.max(0, position / bucket.count));
    return Math.trunc(bucket.min + (bucket.max - bucket.min) * ratio);
  }
  return 30000;
}

/** Purpose: load aggregate telemetry for a guild and synthesize a compact admin report. */
export async function buildTelemetryReport(input: {
  guildId: string;
  period: TelemetryPeriod;
  timeZone: string;
  knownCommandNames?: string[];
}): Promise<TelemetryReport> {
  const periodHours = getPeriodHours(input.period);
  const end = new Date();
  const start = new Date(end.getTime() - periodHours * 60 * 60 * 1000);
  return buildTelemetryReportForWindow({
    guildId: input.guildId,
    start,
    end,
    periodLabel: input.period,
    timeZone: input.timeZone,
    knownCommandNames: input.knownCommandNames,
  });
}

/** Purpose: load aggregate telemetry for an explicit UTC time window. */
export async function buildTelemetryReportForWindow(input: {
  guildId: string;
  start: Date;
  end: Date;
  periodLabel: string;
  timeZone: string;
  knownCommandNames?: string[];
}): Promise<TelemetryReport> {
  const start = input.start;
  const end = input.end;

  const commandRows = await prisma.$queryRaw<CommandRollupRow[]>(
    Prisma.sql`
      SELECT
        "commandName",
        SUM("count")::bigint AS "totalCount",
        SUM("errorCount")::bigint AS "failureCount",
        SUM("timeoutCount")::bigint AS "timeoutCount",
        SUM("totalDurationMs")::bigint AS "totalDurationMs",
        MAX("maxDurationMs")::int AS "maxDurationMs",
        SUM("latencyLt250")::bigint AS "lt250",
        SUM("latencyLt1000")::bigint AS "lt1000",
        SUM("latencyLt3000")::bigint AS "lt3000",
        SUM("latencyLt10000")::bigint AS "lt10000",
        SUM("latencyGte10000")::bigint AS "gte10000"
      FROM "TelemetryCommandAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
      GROUP BY "commandName"
    `
  );

  const userRows = await prisma.$queryRaw<UserRollupRow[]>(
    Prisma.sql`
      SELECT
        "userId",
        SUM("count")::bigint AS "totalCount",
        SUM("failureCount")::bigint AS "failureCount"
      FROM "TelemetryUserCommandAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
      GROUP BY "userId"
      ORDER BY SUM("count") DESC
      LIMIT 5
    `
  );

  const uniqueUserRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(DISTINCT "userId")::bigint AS "count"
      FROM "TelemetryUserCommandAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
    `
  );

  const apiSummaryRows = await prisma.$queryRaw<ApiSummaryRow[]>(
    Prisma.sql`
      SELECT
        COALESCE(SUM("count"), 0)::bigint AS "totalCount",
        COALESCE(SUM("errorCount"), 0)::bigint AS "errorCount",
        COALESCE(SUM("timeoutCount"), 0)::bigint AS "timeoutCount"
      FROM "TelemetryApiAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
    `
  );

  const stageRows = await prisma.$queryRaw<StageSummaryRow[]>(
    Prisma.sql`
      SELECT
        "stage",
        SUM("count")::bigint AS "totalCount",
        SUM("totalDurationMs")::bigint AS "totalDurationMs",
        MAX("maxDurationMs")::int AS "maxDurationMs"
      FROM "TelemetryStageAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
      GROUP BY "stage"
      ORDER BY SUM("totalDurationMs") DESC
      LIMIT 5
    `
  );

  const busiestHourRows = await prisma.$queryRaw<HourSummaryRow[]>(
    Prisma.sql`
      SELECT
        "bucketStart",
        SUM("count")::bigint AS "totalCount"
      FROM "TelemetryCommandAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
      GROUP BY "bucketStart"
      ORDER BY SUM("count") DESC, "bucketStart" DESC
      LIMIT 1
    `
  );

  const busiestDayRows = await prisma.$queryRaw<DaySummaryRow[]>(
    Prisma.sql`
      SELECT
        DATE_TRUNC('day', "bucketStart") AS "dayBucket",
        SUM("count")::bigint AS "totalCount"
      FROM "TelemetryCommandAggregate"
      WHERE
        "guildId" = ${input.guildId}
        AND "bucketStart" >= ${start}
        AND "bucketStart" < ${end}
      GROUP BY DATE_TRUNC('day', "bucketStart")
      ORDER BY SUM("count") DESC, DATE_TRUNC('day', "bucketStart") DESC
      LIMIT 1
    `
  );

  const totalCommands = commandRows.reduce((sum, row) => sum + toNumber(row.totalCount), 0);
  const failedCommands = commandRows.reduce((sum, row) => sum + toNumber(row.failureCount), 0);
  const timeoutCount = commandRows.reduce((sum, row) => sum + toNumber(row.timeoutCount), 0);
  const failureRatePct = totalCommands > 0 ? (failedCommands / totalCommands) * 100 : 0;
  const uniqueUsers = toNumber(uniqueUserRows[0]?.count ?? 0n);

  const apiSummary = apiSummaryRows[0] ?? {
    totalCount: 0n,
    errorCount: 0n,
    timeoutCount: 0n,
  };
  const apiCalls = toNumber(apiSummary.totalCount);
  const apiErrors = toNumber(apiSummary.errorCount);
  const apiTimeouts = toNumber(apiSummary.timeoutCount);
  const apiErrorRatePct = apiCalls > 0 ? (apiErrors / apiCalls) * 100 : 0;

  const commandStats = commandRows.map((row) => {
    const totalCount = toNumber(row.totalCount);
    const failures = toNumber(row.failureCount);
    const totalDurationMs = toNumber(row.totalDurationMs);
    const avgDurationMs = totalCount > 0 ? Math.trunc(totalDurationMs / totalCount) : 0;
    const p95DurationMs = estimatePercentileFromBuckets({
      lt250: toNumber(row.lt250),
      lt1000: toNumber(row.lt1000),
      lt3000: toNumber(row.lt3000),
      lt10000: toNumber(row.lt10000),
      gte10000: toNumber(row.gte10000),
      percentile: 0.95,
    });
    const p99DurationMs = estimatePercentileFromBuckets({
      lt250: toNumber(row.lt250),
      lt1000: toNumber(row.lt1000),
      lt3000: toNumber(row.lt3000),
      lt10000: toNumber(row.lt10000),
      gte10000: toNumber(row.gte10000),
      percentile: 0.99,
    });
    return {
      commandName: row.commandName,
      totalCount,
      failureCount: failures,
      failureRatePct: totalCount > 0 ? (failures / totalCount) * 100 : 0,
      avgDurationMs,
      maxDurationMs: toNumber(row.maxDurationMs),
      p95DurationMs,
      p99DurationMs,
    };
  });

  const defaultCommandNames = [...new Set(
    (COMMAND_PERMISSION_TARGETS as readonly string[])
      .filter((target) => !target.includes(":"))
      .map((target) => target.trim())
      .filter(Boolean)
  )];
  const registeredCommands = input.knownCommandNames?.length
    ? [...new Set(input.knownCommandNames.map((name) => name.trim()).filter(Boolean))]
    : defaultCommandNames;
  const commandCountMap = new Map(commandStats.map((row) => [row.commandName, row.totalCount]));
  const leastUsedCommands = registeredCommands
    .map((commandName) => ({
      commandName,
      totalCount: commandCountMap.get(commandName) ?? 0,
    }))
    .sort((a, b) => (a.totalCount - b.totalCount) || a.commandName.localeCompare(b.commandName))
    .slice(0, 5);

  const busiestHour = busiestHourRows[0]
    ? {
        label: formatDateInTimeZone(new Date(busiestHourRows[0].bucketStart), input.timeZone),
        totalCount: toNumber(busiestHourRows[0].totalCount),
      }
    : null;
  const busiestDay = busiestDayRows[0]
    ? {
        label: new Intl.DateTimeFormat("en-US", {
          timeZone: input.timeZone,
          year: "numeric",
          month: "short",
          day: "2-digit",
        }).format(new Date(busiestDayRows[0].dayBucket)),
        totalCount: toNumber(busiestDayRows[0].totalCount),
      }
    : null;

  return {
    periodLabel: input.periodLabel,
    timeZone: input.timeZone,
    start,
    end,
    totalCommands,
    failedCommands,
    timeoutCount,
    failureRatePct,
    uniqueUsers,
    apiCalls,
    apiErrors,
    apiTimeouts,
    apiErrorRatePct,
    topCommands: [...commandStats]
      .sort((a, b) => (b.totalCount - a.totalCount) || a.commandName.localeCompare(b.commandName))
      .slice(0, 5),
    failedCommandRows: [...commandStats]
      .filter((row) => row.failureCount > 0)
      .sort((a, b) => (b.failureCount - a.failureCount) || a.commandName.localeCompare(b.commandName))
      .slice(0, 5)
      .map((row) => ({
        commandName: row.commandName,
        failureCount: row.failureCount,
        totalCount: row.totalCount,
      })),
    slowestCommands: [...commandStats]
      .sort((a, b) => (b.maxDurationMs - a.maxDurationMs) || a.commandName.localeCompare(b.commandName))
      .slice(0, 5)
      .map((row) => ({
        commandName: row.commandName,
        maxDurationMs: row.maxDurationMs,
        avgDurationMs: row.avgDurationMs,
      })),
    leastUsedCommands,
    mostActiveUsers: userRows.map((row) => ({
      userId: row.userId,
      totalCount: toNumber(row.totalCount),
      failureCount: toNumber(row.failureCount),
    })),
    busiestHour,
    busiestDay,
    hottestStages: stageRows.map((row) => {
      const totalCount = toNumber(row.totalCount);
      const totalDurationMs = toNumber(row.totalDurationMs);
      return {
        stage: row.stage,
        totalCount,
        avgDurationMs: totalCount > 0 ? Math.trunc(totalDurationMs / totalCount) : 0,
        maxDurationMs: toNumber(row.maxDurationMs),
      };
    }),
  };
}
