import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";

export type SettingsDbClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$executeRaw"
>;

export class SettingsService {
  /** Purpose: get. */
  async get(key: string, client: SettingsDbClient = prisma): Promise<string | null> {
    const rows = await client.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`SELECT "value" FROM "BotSetting" WHERE "key" = ${key} LIMIT 1`
    );
    return rows[0]?.value ?? null;
  }

  /** Purpose: set. */
  async set(key: string, value: string, client: SettingsDbClient = prisma): Promise<void> {
    await client.$executeRaw(
      Prisma.sql`
      INSERT INTO "BotSetting" ("key", "value", "createdAt", "updatedAt")
      VALUES (${key}, ${value}, NOW(), NOW())
      ON CONFLICT ("key")
      DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()
    `
    );
  }

  /** Purpose: delete. */
  async delete(key: string, client: SettingsDbClient = prisma): Promise<void> {
    await client.$executeRaw(
      Prisma.sql`DELETE FROM "BotSetting" WHERE "key" = ${key}`
    );
  }
}
