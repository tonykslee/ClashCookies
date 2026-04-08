import { Client } from "discord.js";
import { prisma } from "../prisma";
import { autocompleteSyncTimeZones, normalizeSyncTimeZone } from "./syncTimeZone";
import { formatError } from "../helper/formatError";
import { getRecruitmentCooldown, getRecruitmentTemplate } from "./RecruitmentService";
import { normalizeClanTag } from "./PlayerLinkService";

export type RecruitmentReminderPlatform = "discord" | "reddit" | "band";
export type RecruitmentReminderDeliveryStatus = "SENT" | "FAILED" | "SKIPPED";

export type RecruitmentReminderRuleRecord = {
  id: string;
  guildId: string;
  discordUserId: string;
  clanTag: string;
  platform: RecruitmentReminderPlatform;
  timezone: string;
  nextReminderAt: Date;
  isActive: boolean;
  lastSentAt: Date | null;
  clanNameSnapshot: string | null;
  templateSubject: string | null;
  templateBody: string;
  templateImageUrls: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type RecruitmentReminderDeliveryRecord = {
  id: string;
  reminderRuleId: string;
  scheduledFor: Date;
  sentAt: Date | null;
  status: RecruitmentReminderDeliveryStatus;
  errorDetails: string | null;
  createdAt: Date;
};

export type RecruitmentReminderSnapshot = {
  guildId: string;
  clanTag: string;
  clanName: string | null;
  platform: RecruitmentReminderPlatform;
  timezone: string;
  templateSubject: string | null;
  templateBody: string;
  templateImageUrls: string[];
};

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const SLOT_STEP_MINUTES = 30;
const DEFAULT_SLOT_LOOKAHEAD_DAYS = 14;

type WindowSpec = {
  startMinutes: number;
  endMinutes: number;
  daysOfWeek: number[] | null;
  rhythmLabel: string;
};

const WINDOW_SPECS: Record<RecruitmentReminderPlatform, WindowSpec[]> = {
  discord: [
    {
      startMinutes: 12 * 60,
      endMinutes: 13 * 60,
      daysOfWeek: null,
      rhythmLabel: "Daily around 12:00 PM PST",
    },
    {
      startMinutes: 18 * 60,
      endMinutes: 21 * 60,
      daysOfWeek: null,
      rhythmLabel: "Daily around 7:00 PM PST",
    },
  ],
  reddit: [
    {
      startMinutes: 8 * 60,
      endMinutes: 11 * 60,
      daysOfWeek: [0, 6],
      rhythmLabel: "Sunday around 9:00 AM PST",
    },
  ],
  band: [
    {
      startMinutes: 8 * 60,
      endMinutes: 8 * 60 + 30,
      daysOfWeek: null,
      rhythmLabel: "Daily at 8:00 AM PST",
    },
    {
      startMinutes: 19 * 60,
      endMinutes: 19 * 60 + 30,
      daysOfWeek: null,
      rhythmLabel: "Daily at 7:00 PM PST",
    },
  ],
};

function getOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const token =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "GMT+00";
  const normalized = token.replace("UTC", "GMT");
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

function getTimeZoneParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "0";
  const weekdayText = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[weekdayText] ?? 0,
  };
}

export function getDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = getTimeZoneParts(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

function zonedLocalToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const localMs = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  let utcMs = localMs;
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = getOffsetMinutes(new Date(utcMs), input.timeZone);
    utcMs = localMs - offsetMinutes * 60 * 1000;
  }
  return new Date(utcMs);
}

function addDaysToLocalDateParts(parts: { year: number; month: number; day: number }, days: number) {
  const anchor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  const localized = getTimeZoneParts(anchor, PACIFIC_TIME_ZONE);
  return {
    year: localized.year,
    month: localized.month,
    day: localized.day,
  };
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatTimeInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function platformLabel(platform: RecruitmentReminderPlatform): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function normalizeRecruitmentPlatform(input: string): RecruitmentReminderPlatform | null {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "discord" || value === "reddit" || value === "band") {
    return value;
  }
  return null;
}

export function normalizeRecruitmentTimezone(input: string | null | undefined): string | null {
  return normalizeSyncTimeZone(input);
}

export function autocompleteRecruitmentTimeZones(input: string | null | undefined) {
  return autocompleteSyncTimeZones(input);
}

export function getRecruitmentReminderPlatformLabel(platform: RecruitmentReminderPlatform): string {
  return platformLabel(platform);
}

export function getRecruitmentReminderPlatformWindows(platform: RecruitmentReminderPlatform): WindowSpec[] {
  return [...WINDOW_SPECS[platform]];
}

export function formatRecruitmentReminderWindowSummary(
  platform: RecruitmentReminderPlatform,
): string {
  const windows = WINDOW_SPECS[platform];
  return windows
    .map((window) => {
      const startHour = Math.floor(window.startMinutes / 60);
      const startMinute = window.startMinutes % 60;
      const endHour = Math.floor(window.endMinutes / 60);
      const endMinute = window.endMinutes % 60;
      return `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")} - ${String(
        endHour,
      ).padStart(2, "0")}:${String(endMinute).padStart(2, "0")} PST`;
    })
    .join(", ");
}

export function formatRecruitmentReminderWindowSummaryInTimeZone(
  platform: RecruitmentReminderPlatform,
  timeZone: string,
  referenceDate = new Date(),
): string {
  const basePacific = getTimeZoneParts(referenceDate, PACIFIC_TIME_ZONE);
  return WINDOW_SPECS[platform]
    .map((window) => {
      const start = zonedLocalToUtc({
        year: basePacific.year,
        month: basePacific.month,
        day: basePacific.day,
        hour: Math.floor(window.startMinutes / 60),
        minute: window.startMinutes % 60,
        timeZone: PACIFIC_TIME_ZONE,
      });
      const end = zonedLocalToUtc({
        year: basePacific.year,
        month: basePacific.month,
        day: basePacific.day,
        hour: Math.floor(window.endMinutes / 60),
        minute: window.endMinutes % 60,
        timeZone: PACIFIC_TIME_ZONE,
      });
      const scope = window.daysOfWeek ? "Weekend" : "Daily";
      return `${scope} ${formatTimeInTimeZone(start, timeZone)} - ${formatTimeInTimeZone(end, timeZone)}`;
    })
    .join(", ");
}

export function formatRecruitmentReminderRhythmSummaryInTimeZone(
  platform: RecruitmentReminderPlatform,
  timeZone: string,
  referenceDate = new Date(),
): string {
  const basePacific = getTimeZoneParts(referenceDate, PACIFIC_TIME_ZONE);
  if (platform === "discord") {
    const rhythm = zonedLocalToUtc({
      year: basePacific.year,
      month: basePacific.month,
      day: basePacific.day,
      hour: 19,
      minute: 0,
      timeZone: PACIFIC_TIME_ZONE,
    });
    return `Daily around ${formatTimeInTimeZone(rhythm, timeZone)}`;
  }
  if (platform === "reddit") {
    const rhythm = zonedLocalToUtc({
      year: basePacific.year,
      month: basePacific.month,
      day: basePacific.day,
      hour: 9,
      minute: 0,
      timeZone: PACIFIC_TIME_ZONE,
    });
    return `Sunday around ${formatTimeInTimeZone(rhythm, timeZone)}`;
  }
  const eightAm = zonedLocalToUtc({
    year: basePacific.year,
    month: basePacific.month,
    day: basePacific.day,
    hour: 8,
    minute: 0,
    timeZone: PACIFIC_TIME_ZONE,
  });
  const sevenPm = zonedLocalToUtc({
    year: basePacific.year,
    month: basePacific.month,
    day: basePacific.day,
    hour: 19,
    minute: 0,
    timeZone: PACIFIC_TIME_ZONE,
  });
  return `Daily at ${formatTimeInTimeZone(eightAm, timeZone)} and ${formatTimeInTimeZone(
    sevenPm,
    timeZone,
  )}`;
}

export function getRecruitmentReminderRhythmLabel(platform: RecruitmentReminderPlatform): string {
  return WINDOW_SPECS[platform][0]?.rhythmLabel ?? "Daily";
}

export function formatRecruitmentReminderTime(date: Date, timeZone: string): string {
  return formatDateInTimeZone(date, timeZone);
}

export function getRecruitmentReminderSlotCandidates(input: {
  platform: RecruitmentReminderPlatform;
  timezone: string;
  after: Date;
  cooldownExpiresAt?: Date | null;
  lookaheadDays?: number;
}): Date[] {
  const normalizedZone = normalizeRecruitmentTimezone(input.timezone) ?? "UTC";
  const afterMs = Math.max(
    input.after.getTime(),
    input.cooldownExpiresAt?.getTime() ?? input.after.getTime(),
  );
  const basePacific = getTimeZoneParts(input.after, PACIFIC_TIME_ZONE);
  const lookaheadDays = Math.max(1, Math.trunc(Number(input.lookaheadDays) || DEFAULT_SLOT_LOOKAHEAD_DAYS));
  const windows = WINDOW_SPECS[input.platform];
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset <= lookaheadDays; dayOffset += 1) {
    const localDay = addDaysToLocalDateParts(basePacific, dayOffset);
    for (const window of windows) {
      const candidateDayAnchor = zonedLocalToUtc({
        year: localDay.year,
        month: localDay.month,
        day: localDay.day,
        hour: Math.floor(window.startMinutes / 60),
        minute: window.startMinutes % 60,
        timeZone: PACIFIC_TIME_ZONE,
      });
      const weekday = getTimeZoneParts(candidateDayAnchor, PACIFIC_TIME_ZONE).weekday;
      if (window.daysOfWeek && !window.daysOfWeek.includes(weekday)) {
        continue;
      }

      for (let minute = window.startMinutes; minute < window.endMinutes; minute += SLOT_STEP_MINUTES) {
        const slot = zonedLocalToUtc({
          year: localDay.year,
          month: localDay.month,
          day: localDay.day,
          hour: Math.floor(minute / 60),
          minute: minute % 60,
          timeZone: PACIFIC_TIME_ZONE,
        });
        if (slot.getTime() <= afterMs) continue;
        candidates.push(slot);
      }
    }
  }

  const uniqueSorted = [...new Map(candidates.map((slot) => [slot.getTime(), slot])).values()]
    .sort((a, b) => a.getTime() - b.getTime());
  return uniqueSorted;
}

export function getNextRecruitmentReminderSlot(input: {
  platform: RecruitmentReminderPlatform;
  timezone: string;
  after: Date;
  cooldownExpiresAt?: Date | null;
}): Date | null {
  return getRecruitmentReminderSlotCandidates(input)[0] ?? null;
}

export function buildRecruitmentReminderDmContent(input: {
  clanTag: string;
  clanName: string | null;
  platform: RecruitmentReminderPlatform;
  cooldownExpiresAt: Date | null;
  templateSubject: string | null;
  templateBody: string;
  templateImageUrls: string[];
}): string {
  const lines = [
    `Recruitment reminder for ${input.clanName ? `${input.clanName} ` : ""}${input.clanTag}`,
    `Platform: ${platformLabel(input.platform)}`,
  ];
  if (input.cooldownExpiresAt) {
    const unix = Math.floor(input.cooldownExpiresAt.getTime() / 1000);
    lines.push(`Cooldown: active until <t:${unix}:R>`);
  } else {
    lines.push("Cooldown: ready now");
  }
  if (input.templateSubject) {
    lines.push(`Subject: \`${input.templateSubject}\``);
  }
  lines.push("Template:");
  lines.push("```");
  lines.push(input.templateBody);
  lines.push("```");
  if (input.templateImageUrls.length > 0) {
    lines.push("Images:");
    lines.push(...input.templateImageUrls.map((url) => `- ${url}`));
  }
  return lines.join("\n");
}

export async function upsertRecruitmentReminderRule(input: {
  guildId: string;
  discordUserId: string;
  clanTag: string;
  platform: RecruitmentReminderPlatform;
  timezone: string;
  nextReminderAt: Date;
  isActive: boolean;
  lastSentAt?: Date | null;
  clanNameSnapshot?: string | null;
  templateSubject?: string | null;
  templateBody: string;
  templateImageUrls: string[];
}): Promise<RecruitmentReminderRuleRecord> {
  const clanTag = normalizeClanTag(input.clanTag);
  const existing = await prisma.recruitmentReminderRule.findFirst({
    where: {
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      clanTag,
      platform: input.platform,
    },
  });
  const data = {
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    clanTag,
    platform: input.platform,
    timezone: normalizeRecruitmentTimezone(input.timezone) ?? input.timezone,
    nextReminderAt: input.nextReminderAt,
    isActive: input.isActive,
    lastSentAt: input.lastSentAt ?? null,
    clanNameSnapshot: input.clanNameSnapshot ?? null,
    templateSubject: input.templateSubject ?? null,
    templateBody: input.templateBody,
    templateImageUrls: input.templateImageUrls,
  };
  const row = existing
    ? await prisma.recruitmentReminderRule.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.recruitmentReminderRule.create({ data });
  return row as RecruitmentReminderRuleRecord;
}

export async function listRecruitmentReminderRulesForUser(input: {
  guildId: string;
  discordUserId: string;
}): Promise<RecruitmentReminderRuleRecord[]> {
  return prisma.recruitmentReminderRule.findMany({
    where: {
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      isActive: true,
    },
    orderBy: [{ nextReminderAt: "asc" }, { clanTag: "asc" }, { platform: "asc" }],
  }) as Promise<RecruitmentReminderRuleRecord[]>;
}

export async function listRecruitmentReminderRulesByClanTags(input: {
  guildId: string;
  clanTags: string[];
}): Promise<RecruitmentReminderRuleRecord[]> {
  const clanTags = [...new Set(input.clanTags.map(normalizeClanTag).filter(Boolean))];
  if (clanTags.length <= 0) return [];
  return prisma.recruitmentReminderRule.findMany({
    where: {
      guildId: input.guildId,
      clanTag: { in: clanTags },
      isActive: true,
    },
    orderBy: [{ clanTag: "asc" }, { platform: "asc" }],
  }) as Promise<RecruitmentReminderRuleRecord[]>;
}

export async function removeRecruitmentReminderRulesByIds(input: {
  guildId: string;
  discordUserId: string;
  ruleIds: string[];
}): Promise<number> {
  const uniqueIds = [...new Set(input.ruleIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (uniqueIds.length <= 0) return 0;
  const deleted = await prisma.recruitmentReminderRule.deleteMany({
    where: {
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      id: { in: uniqueIds },
    },
  });
  return deleted.count;
}

export async function listDueRecruitmentReminderRules(input: {
  now: Date;
}): Promise<RecruitmentReminderRuleRecord[]> {
  return prisma.recruitmentReminderRule.findMany({
    where: {
      isActive: true,
      nextReminderAt: { lte: input.now },
    },
    orderBy: [{ nextReminderAt: "asc" }, { guildId: "asc" }, { clanTag: "asc" }],
  }) as Promise<RecruitmentReminderRuleRecord[]>;
}

export async function createRecruitmentReminderDelivery(input: {
  reminderRuleId: string;
  scheduledFor: Date;
  status: RecruitmentReminderDeliveryStatus;
  sentAt?: Date | null;
  errorDetails?: string | null;
}): Promise<RecruitmentReminderDeliveryRecord> {
  const row = await prisma.recruitmentReminderDelivery.create({
    data: {
      reminderRuleId: input.reminderRuleId,
      scheduledFor: input.scheduledFor,
      status: input.status,
      sentAt: input.sentAt ?? null,
      errorDetails: input.errorDetails ?? null,
    },
  });
  return row as RecruitmentReminderDeliveryRecord;
}

export async function processDueRecruitmentReminders(input: {
  client: Client;
  now?: Date;
}): Promise<{ evaluated: number; sent: number; failed: number }> {
  const now = input.now ?? new Date();
  const dueRules = await listDueRecruitmentReminderRules({ now });
  let evaluated = 0;
  let sent = 0;
  let failed = 0;

  for (const rule of dueRules) {
    evaluated += 1;
    const cooldown = await getRecruitmentCooldown(rule.guildId, rule.discordUserId, rule.clanTag, rule.platform as any);
    const template = await getRecruitmentTemplate(rule.guildId, rule.clanTag, rule.platform as any);
    const content = buildRecruitmentReminderDmContent({
      clanTag: rule.clanTag,
      clanName: rule.clanNameSnapshot,
      platform: rule.platform,
      cooldownExpiresAt: cooldown?.expiresAt ?? null,
      templateSubject: rule.templateSubject ?? template?.subject ?? null,
      templateBody: rule.templateBody || template?.body || "",
      templateImageUrls: rule.templateImageUrls.length > 0 ? rule.templateImageUrls : template?.imageUrls ?? [],
    });

    try {
      const user = await input.client.users.fetch(rule.discordUserId);
      await user.send({ content });
      const nextReminderAt =
        getNextRecruitmentReminderSlot({
          platform: rule.platform,
          timezone: rule.timezone,
          after: now,
          cooldownExpiresAt: cooldown?.expiresAt ?? null,
        }) ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await prisma.recruitmentReminderRule.update({
        where: { id: rule.id },
        data: {
          lastSentAt: now,
          nextReminderAt,
        },
      });
      await createRecruitmentReminderDelivery({
        reminderRuleId: rule.id,
        scheduledFor: rule.nextReminderAt,
        status: "SENT",
        sentAt: now,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[recruitment-reminder] send_failed guild=${rule.guildId} user=${rule.discordUserId} clan=${rule.clanTag} platform=${rule.platform} error=${formatError(
          error,
        )}`,
      );
      await createRecruitmentReminderDelivery({
        reminderRuleId: rule.id,
        scheduledFor: rule.nextReminderAt,
        status: "FAILED",
        errorDetails: formatError(error).slice(0, 500),
      }).catch(() => undefined);
    }
  }

  return { evaluated, sent, failed };
}

export const recruitmentReminderService = {
  autocompleteRecruitmentTimeZones,
  formatRecruitmentReminderTime,
  formatRecruitmentReminderWindowSummary,
  formatRecruitmentReminderWindowSummaryInTimeZone,
  formatRecruitmentReminderRhythmSummaryInTimeZone,
  getNextRecruitmentReminderSlot,
  getRecruitmentReminderPlatformLabel,
  getRecruitmentReminderPlatformWindows,
  getRecruitmentReminderRhythmLabel,
  getRecruitmentReminderSlotCandidates,
  listDueRecruitmentReminderRules,
  listRecruitmentReminderRulesByClanTags,
  listRecruitmentReminderRulesForUser,
  normalizeRecruitmentPlatform,
  normalizeRecruitmentTimezone,
  processDueRecruitmentReminders,
  removeRecruitmentReminderRulesByIds,
  upsertRecruitmentReminderRule,
  buildRecruitmentReminderDmContent,
};
