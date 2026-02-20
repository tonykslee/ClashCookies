import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";

export class SettingsService {
  async get(key: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`SELECT "value" FROM "BotSetting" WHERE "key" = ${key} LIMIT 1`
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await prisma.$executeRaw(
      Prisma.sql`
      INSERT INTO "BotSetting" ("key", "value", "createdAt", "updatedAt")
      VALUES (${key}, ${value}, NOW(), NOW())
      ON CONFLICT ("key")
      DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()
    `
    );
  }

  async delete(key: string): Promise<void> {
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM "BotSetting" WHERE "key" = ${key}`
    );
  }
}
