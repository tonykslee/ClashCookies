import { Client } from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";

export type RecruitmentPlatform = "discord" | "reddit" | "band";

export type RecruitmentTemplateRecord = {
  clanTag: string;
  platform: RecruitmentPlatform;
  subject: string | null;
  body: string;
  imageUrls: string[];
  updatedAt: Date;
};

export type RecruitmentCooldownRecord = {
  id: number;
  userId: string;
  clanTag: string;
  platform: RecruitmentPlatform;
  startedAt: Date;
  expiresAt: Date;
  reminded: boolean;
};

const PLATFORM_DURATION_MS: Record<RecruitmentPlatform, number> = {
  discord: 24 * 60 * 60 * 1000,
  band: 12 * 60 * 60 * 1000,
  reddit: 7 * 24 * 60 * 60 * 1000,
};

export function normalizeClanTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

export function formatClanTag(tag: string): string {
  const normalized = normalizeClanTag(tag);
  return `#${normalized}`;
}

export function getRecruitmentCooldownDurationMs(platform: RecruitmentPlatform): number {
  return PLATFORM_DURATION_MS[platform];
}

export function parseRecruitmentPlatform(input: string): RecruitmentPlatform | null {
  const value = input.trim().toLowerCase();
  if (value === "discord" || value === "reddit" || value === "band") {
    return value;
  }
  return null;
}

export function parseImageUrlsCsv(input: string): string[] {
  if (!input.trim()) return [];
  return [...new Set(input.split(",").map((v) => v.trim()).filter(Boolean))];
}

export function toImageUrlsCsv(imageUrls: string[]): string {
  return imageUrls.join(", ");
}

export async function getRecruitmentTemplate(
  clanTag: string,
  platform: RecruitmentPlatform
): Promise<RecruitmentTemplateRecord | null> {
  const normalized = normalizeClanTag(clanTag);
  const rows = await prisma.$queryRaw<RecruitmentTemplateRecord[]>(
    Prisma.sql`
      SELECT
        "clanTag",
        "platform",
        "subject",
        "body",
        "imageUrls",
        "updatedAt"
      FROM "RecruitmentTemplate"
      WHERE
        "clanTag" = ${normalized}
        AND "platform" = ${platform}::"RecruitmentPlatform"
      LIMIT 1
    `
  );
  return rows[0] ?? null;
}

export async function upsertRecruitmentTemplate(input: {
  clanTag: string;
  platform: RecruitmentPlatform;
  subject?: string | null;
  body: string;
  imageUrls: string[];
}): Promise<void> {
  const normalized = normalizeClanTag(input.clanTag);
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "RecruitmentTemplate"
        ("clanTag", "platform", "subject", "requiredTH", "focus", "body", "imageUrls", "createdAt", "updatedAt")
      VALUES
        (${normalized}, ${input.platform}::"RecruitmentPlatform", ${input.subject ?? null}, '', '', ${input.body}, ${input.imageUrls}::text[], NOW(), NOW())
      ON CONFLICT ("clanTag", "platform")
      DO UPDATE SET
        "subject" = EXCLUDED."subject",
        "body" = EXCLUDED."body",
        "imageUrls" = EXCLUDED."imageUrls",
        "updatedAt" = NOW()
    `
  );
}

export async function getRecruitmentCooldown(
  userId: string,
  clanTag: string,
  platform: RecruitmentPlatform
): Promise<RecruitmentCooldownRecord | null> {
  const normalized = normalizeClanTag(clanTag);
  const rows = await prisma.$queryRaw<RecruitmentCooldownRecord[]>(
    Prisma.sql`
      SELECT
        "id",
        "userId",
        "clanTag",
        "platform",
        "startedAt",
        "expiresAt",
        "reminded"
      FROM "RecruitmentCooldown"
      WHERE
        "userId" = ${userId}
        AND "clanTag" = ${normalized}
        AND "platform" = ${platform}::"RecruitmentPlatform"
      LIMIT 1
    `
  );
  return rows[0] ?? null;
}

export async function startOrResetRecruitmentCooldown(input: {
  userId: string;
  clanTag: string;
  platform: RecruitmentPlatform;
  startedAt: Date;
  expiresAt: Date;
}): Promise<void> {
  const normalized = normalizeClanTag(input.clanTag);
  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "RecruitmentCooldown"
        ("userId", "clanTag", "platform", "startedAt", "expiresAt", "reminded", "createdAt", "updatedAt")
      VALUES
        (${input.userId}, ${normalized}, ${input.platform}::"RecruitmentPlatform", ${input.startedAt}, ${input.expiresAt}, false, NOW(), NOW())
      ON CONFLICT ("userId", "clanTag", "platform")
      DO UPDATE SET
        "startedAt" = EXCLUDED."startedAt",
        "expiresAt" = EXCLUDED."expiresAt",
        "reminded" = false,
        "updatedAt" = NOW()
    `
  );
}

export async function listRecruitmentCooldownsForUser(
  userId: string
): Promise<RecruitmentCooldownRecord[]> {
  return prisma.$queryRaw<RecruitmentCooldownRecord[]>(
    Prisma.sql`
      SELECT
        "id",
        "userId",
        "clanTag",
        "platform",
        "startedAt",
        "expiresAt",
        "reminded"
      FROM "RecruitmentCooldown"
      WHERE "userId" = ${userId}
      ORDER BY "expiresAt" ASC
    `
  );
}

export async function listRecruitmentCooldownsForUserByClanTags(
  userId: string,
  clanTags: string[]
): Promise<RecruitmentCooldownRecord[]> {
  const normalized = [...new Set(clanTags.map(normalizeClanTag).filter(Boolean))];
  if (normalized.length === 0) return [];

  return prisma.$queryRaw<RecruitmentCooldownRecord[]>(
    Prisma.sql`
      SELECT
        "id",
        "userId",
        "clanTag",
        "platform",
        "startedAt",
        "expiresAt",
        "reminded"
      FROM "RecruitmentCooldown"
      WHERE
        "userId" = ${userId}
        AND "clanTag" = ANY (${normalized}::text[])
      ORDER BY "clanTag" ASC, "platform" ASC
    `
  );
}

export async function getTrackedClanNameMapByTags(
  clanTags: string[]
): Promise<Map<string, string>> {
  const normalized = [...new Set(clanTags.map(normalizeClanTag).filter(Boolean))];
  if (normalized.length === 0) return new Map();

  const rows = await prisma.trackedClan.findMany({
    where: {
      tag: {
        in: normalized.map((t) => `#${t}`),
      },
    },
    select: { tag: true, name: true },
  });

  return new Map(
    rows.map((row) => [normalizeClanTag(row.tag), row.name?.trim() || `#${normalizeClanTag(row.tag)}`])
  );
}

export async function processRecruitmentCooldownReminders(client: Client): Promise<void> {
  const now = new Date();
  const dueRows = await prisma.$queryRaw<RecruitmentCooldownRecord[]>(
    Prisma.sql`
      SELECT
        "id",
        "userId",
        "clanTag",
        "platform",
        "startedAt",
        "expiresAt",
        "reminded"
      FROM "RecruitmentCooldown"
      WHERE
        "expiresAt" <= ${now}
        AND "reminded" = false
      ORDER BY "expiresAt" ASC
    `
  );

  if (dueRows.length === 0) return;

  const clanNameByTag = await getTrackedClanNameMapByTags(dueRows.map((row) => row.clanTag));
  for (const row of dueRows) {
    const tag = normalizeClanTag(row.clanTag);
    const clanLabel = clanNameByTag.get(tag) ?? formatClanTag(tag);
    const message = `Your ${row.platform} recruitment cooldown for ${clanLabel} (${formatClanTag(
      tag
    )}) has expired.`;

    try {
      const user = await client.users.fetch(row.userId);
      await user.send(message);
    } catch (err) {
      console.warn(
        `[recruitment] reminder send failed user=${row.userId} platform=${row.platform} clan=${formatClanTag(
          tag
        )} error=${formatError(err)}`
      );
    }

    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "RecruitmentCooldown"
        SET "reminded" = true, "updatedAt" = NOW()
        WHERE "id" = ${row.id}
      `
    );
  }
}
