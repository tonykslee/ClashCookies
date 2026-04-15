import { prisma } from "../prisma";

export type DumpLinkRecord = {
  guildId: string;
  link: string;
  updatedByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export function normalizeDumpLink(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  if (!unwrapped) return null;

  try {
    const parsed = new URL(unwrapped);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return unwrapped;
  } catch {
    return null;
  }
}

export async function getDumpLinkForGuild(
  guildId: string,
): Promise<DumpLinkRecord | null> {
  const normalizedGuildId = String(guildId ?? "").trim();
  if (!normalizedGuildId) return null;

  return prisma.dumpLink.findUnique({
    where: { guildId: normalizedGuildId },
    select: {
      guildId: true,
      link: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function upsertDumpLinkForGuild(input: {
  guildId: string;
  link: string;
  updatedByDiscordUserId: string;
}): Promise<DumpLinkRecord> {
  const guildId = String(input.guildId ?? "").trim();
  const link = String(input.link ?? "").trim();
  const updatedByDiscordUserId = String(input.updatedByDiscordUserId ?? "").trim();

  return prisma.dumpLink.upsert({
    where: { guildId },
    create: {
      guildId,
      link,
      updatedByDiscordUserId,
    },
    update: {
      link,
      updatedByDiscordUserId,
    },
    select: {
      guildId: true,
      link: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
