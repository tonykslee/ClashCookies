import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Client } from "discord.js";
import { truncateDiscordContent } from "../../helper/discordContent";
import { formatError } from "../../helper/formatError";
import { prisma } from "../../prisma";
import { buildTelemetryReportForWindow, renderTelemetryReport } from "./report";
import {
  formatDateInTimeZone,
  getPreviousCompletedWindow,
  isValidIanaTimeZone,
  normalizeCadenceHours,
} from "./timeWindow";

const TELEMETRY_SCHEDULE_POLL_MS = Math.max(
  60_000,
  Number(process.env.TELEMETRY_SCHEDULE_POLL_MS ?? 5 * 60 * 1000)
);

type TelemetryScheduleRow = {
  id: string;
  guildId: string;
  channelId: string;
  cadenceHours: number;
  timezone: string;
  enabled: boolean;
  lastPostedWindowStart: Date | null;
  lastPostedWindowEnd: Date | null;
  lastPostedAt: Date | null;
  lastMessageId: string | null;
};

/** Purpose: normalize and validate timezone with UTC fallback for persisted schedule rows. */
function normalizeTimeZone(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "UTC";
  return isValidIanaTimeZone(text) ? text : "UTC";
}

/** Purpose: load one guild's telemetry report schedule. */
export async function getTelemetryReportSchedule(
  guildId: string
): Promise<TelemetryScheduleRow | null> {
  const rows = await prisma.$queryRaw<TelemetryScheduleRow[]>(
    Prisma.sql`
      SELECT
        "id",
        "guildId",
        "channelId",
        "cadenceHours",
        "timezone",
        "enabled",
        "lastPostedWindowStart",
        "lastPostedWindowEnd",
        "lastPostedAt",
        "lastMessageId"
      FROM "TelemetryReportSchedule"
      WHERE "guildId" = ${guildId}
      LIMIT 1
    `
  );
  return rows[0] ?? null;
}

/** Purpose: upsert telemetry report schedule for a guild. */
export async function upsertTelemetryReportSchedule(input: {
  guildId: string;
  channelId: string;
  cadenceHours: number;
  timezone: string;
  enabled: boolean;
}): Promise<void> {
  const cadenceHours = normalizeCadenceHours(input.cadenceHours);
  const timezone = normalizeTimeZone(input.timezone);
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "TelemetryReportSchedule"
        (
          "id",
          "guildId",
          "channelId",
          "cadenceHours",
          "timezone",
          "enabled",
          "createdAt",
          "updatedAt"
        )
      VALUES
        (${randomUUID()}, ${input.guildId}, ${input.channelId}, ${cadenceHours}, ${timezone}, ${input.enabled}, NOW(), NOW())
      ON CONFLICT ("guildId")
      DO UPDATE SET
        "channelId" = EXCLUDED."channelId",
        "cadenceHours" = EXCLUDED."cadenceHours",
        "timezone" = EXCLUDED."timezone",
        "enabled" = EXCLUDED."enabled",
        "updatedAt" = NOW()
    `
  );
}

/** Purpose: disable telemetry schedule for a guild without deleting schedule config. */
export async function disableTelemetryReportSchedule(guildId: string): Promise<void> {
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "TelemetryReportSchedule"
      SET "enabled" = false, "updatedAt" = NOW()
      WHERE "guildId" = ${guildId}
    `
  );
}

/** Purpose: render schedule summary for command feedback. */
export function formatTelemetryScheduleSummary(schedule: TelemetryScheduleRow | null): string {
  if (!schedule) return "No telemetry schedule configured.";
  const lines = [
    `Enabled: ${schedule.enabled ? "Yes" : "No"}`,
    `Channel: <#${schedule.channelId}>`,
    `Cadence: every ${schedule.cadenceHours} hour(s)`,
    `Timezone: ${schedule.timezone}`,
  ];
  if (schedule.lastPostedAt) {
    lines.push(`Last posted: <t:${Math.floor(schedule.lastPostedAt.getTime() / 1000)}:F>`);
  }
  if (schedule.lastPostedWindowStart && schedule.lastPostedWindowEnd) {
    lines.push(
      `Last window: ${formatDateInTimeZone(schedule.lastPostedWindowStart, schedule.timezone)} -> ${formatDateInTimeZone(
        schedule.lastPostedWindowEnd,
        schedule.timezone
      )}`
    );
  }
  return lines.join("\n");
}

/** Purpose: post one scheduled telemetry report for a completed cadence window with idempotent run guards. */
export async function runTelemetryScheduleOnce(
  client: Client,
  schedule: TelemetryScheduleRow
): Promise<boolean> {
  if (!schedule.enabled) return false;

  const now = new Date();
  const normalizedCadence = normalizeCadenceHours(schedule.cadenceHours);
  const timeZone = normalizeTimeZone(schedule.timezone);
  const window = getPreviousCompletedWindow(now, normalizedCadence, timeZone);

  const inserted = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      INSERT INTO "TelemetryReportRun"
        (
          "id",
          "guildId",
          "channelId",
          "windowStart",
          "windowEnd",
          "cadenceHours",
          "timezone",
          "status",
          "createdAt",
          "updatedAt"
        )
      VALUES
        (
          ${randomUUID()},
          ${schedule.guildId},
          ${schedule.channelId},
          ${window.start},
          ${window.end},
          ${normalizedCadence},
          ${timeZone},
          'pending',
          NOW(),
          NOW()
        )
      ON CONFLICT ("guildId", "windowStart", "windowEnd")
      DO NOTHING
      RETURNING "id"
    `
  );

  if (inserted.length === 0) {
    return false;
  }

  const runId = inserted[0].id;
  try {
    const report = await buildTelemetryReportForWindow({
      guildId: schedule.guildId,
      start: window.start,
      end: window.end,
      periodLabel: `${normalizedCadence}h`,
      timeZone,
    });
    const content = truncateDiscordContent(renderTelemetryReport(report));

    const guild = await client.guilds.fetch(schedule.guildId);
    const channel = await guild.channels.fetch(schedule.channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error("Configured telemetry channel is not text-based.");
    }

    const message = await channel.send({ content });
    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "TelemetryReportRun"
        SET
          "status" = 'posted',
          "messageId" = ${message.id},
          "postedAt" = NOW(),
          "updatedAt" = NOW()
        WHERE "id" = ${runId}
      `
    );
    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "TelemetryReportSchedule"
        SET
          "lastPostedWindowStart" = ${window.start},
          "lastPostedWindowEnd" = ${window.end},
          "lastPostedAt" = NOW(),
          "lastMessageId" = ${message.id},
          "updatedAt" = NOW()
        WHERE "id" = ${schedule.id}
      `
    );
    return true;
  } catch (err) {
    const errorCode = String((err as { code?: unknown } | null | undefined)?.code ?? "SEND_FAILED");
    const errorMessage = String((err as { message?: unknown } | null | undefined)?.message ?? err).slice(0, 250);
    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "TelemetryReportRun"
        SET
          "status" = 'failed',
          "errorCode" = ${errorCode},
          "errorMessage" = ${errorMessage},
          "updatedAt" = NOW()
        WHERE "id" = ${runId}
      `
    );
    console.error(
      `[telemetry-v2] scheduled report failed guild=${schedule.guildId} channel=${schedule.channelId} window_start=${window.start.toISOString()} error=${formatError(
        err
      )}`
    );
    return false;
  }
}

/** Purpose: process all enabled telemetry schedules for due windows. */
export async function runDueTelemetrySchedules(client: Client): Promise<number> {
  const schedules = await prisma.$queryRaw<TelemetryScheduleRow[]>(
    Prisma.sql`
      SELECT
        "id",
        "guildId",
        "channelId",
        "cadenceHours",
        "timezone",
        "enabled",
        "lastPostedWindowStart",
        "lastPostedWindowEnd",
        "lastPostedAt",
        "lastMessageId"
      FROM "TelemetryReportSchedule"
      WHERE "enabled" = true
      ORDER BY "updatedAt" ASC
    `
  );

  let posted = 0;
  for (const schedule of schedules) {
    const didPost = await runTelemetryScheduleOnce(client, schedule);
    if (didPost) posted += 1;
  }
  return posted;
}

/** Purpose: start the recurring telemetry schedule polling loop and trigger one immediate pass. */
export function startTelemetryScheduleLoop(client: Client): void {
  const tick = async () => {
    try {
      await runDueTelemetrySchedules(client);
    } catch (err) {
      console.error(`[telemetry-v2] schedule loop failed error=${formatError(err)}`);
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, TELEMETRY_SCHEDULE_POLL_MS);
}
