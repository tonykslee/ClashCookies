import { BanRecord, BanTargetKind } from "@prisma/client";
import { prisma } from "../prisma";
import {
  listPlayerLinksForDiscordUser,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";

export type BanMutationOutcome = "created" | "updated" | "invalid_target";
export type BanRemovalOutcome = "removed" | "not_found" | "invalid_target";

export type BanMutationResult = {
  outcome: BanMutationOutcome;
  record: BanRecord | null;
};

export type BanRemovalResult = {
  outcome: BanRemovalOutcome;
  record: BanRecord | null;
};

export type BanListRecord = BanRecord & {
  linkedPlayerTags: string[];
};

type BanTimestampInput = {
  guildId: string;
  reason?: string | null;
  bannedByDiscordUserId: string;
  expiresAt?: Date | null;
  now?: Date;
};

function normalizeBanReason(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function isActiveBanRecord(record: Pick<BanRecord, "removedAt" | "expiresAt">, now: Date): boolean {
  if (record.removedAt !== null) return false;
  if (record.expiresAt === null) return true;
  return record.expiresAt.getTime() > now.getTime();
}

function buildPlayerBanWhere(guildId: string, playerTag: string, now: Date) {
  return {
    guildId,
    targetKind: BanTargetKind.PLAYER,
    playerTag,
    removedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

function buildUserBanWhere(guildId: string, discordUserId: string, now: Date) {
  return {
    guildId,
    targetKind: BanTargetKind.USER,
    discordUserId,
    removedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

async function upsertActiveBanRecord(input: {
  guildId: string;
  targetKind: BanTargetKind;
  playerTag?: string | null;
  discordUserId?: string | null;
  reason?: string | null;
  bannedByDiscordUserId: string;
  expiresAt?: Date | null;
  now?: Date;
}): Promise<BanMutationResult> {
  const now = input.now ?? new Date();
  const reason = normalizeBanReason(input.reason);
  const expiresAt = input.expiresAt ?? null;

  const where =
    input.targetKind === BanTargetKind.PLAYER
      ? buildPlayerBanWhere(input.guildId, String(input.playerTag ?? ""), now)
      : buildUserBanWhere(input.guildId, String(input.discordUserId ?? ""), now);

  const existing = await prisma.banRecord.findFirst({
    where,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      guildId: true,
      targetKind: true,
      playerTag: true,
      discordUserId: true,
      reason: true,
      bannedByDiscordUserId: true,
      createdAt: true,
      expiresAt: true,
      removedAt: true,
      removedByDiscordUserId: true,
      removeReason: true,
      updatedAt: true,
    },
  });

  if (existing) {
    const updated = await prisma.banRecord.update({
      where: { id: existing.id },
      data: {
        reason,
        expiresAt,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
      },
    });
    return { outcome: "updated", record: updated };
  }

  try {
    const created = await prisma.banRecord.create({
      data: {
        guildId: input.guildId,
        targetKind: input.targetKind,
        playerTag: input.playerTag ?? null,
        discordUserId: input.discordUserId ?? null,
        reason,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        expiresAt,
      },
    });
    return { outcome: "created", record: created };
  } catch (error) {
    const code = (error as { code?: string } | null | undefined)?.code ?? "";
    if (code !== "P2002") throw error;

    const racedExisting = await prisma.banRecord.findFirst({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    if (!racedExisting) {
      throw error;
    }

    const updated = await prisma.banRecord.update({
      where: { id: racedExisting.id },
      data: {
        reason,
        expiresAt,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
      },
    });
    return { outcome: "updated", record: updated };
  }
}

async function removeActiveBanRecord(input: {
  guildId: string;
  targetKind: BanTargetKind;
  playerTag?: string | null;
  discordUserId?: string | null;
  removedByDiscordUserId: string;
  now?: Date;
}): Promise<BanRemovalResult> {
  const now = input.now ?? new Date();
  const where =
    input.targetKind === BanTargetKind.PLAYER
      ? buildPlayerBanWhere(input.guildId, String(input.playerTag ?? ""), now)
      : buildUserBanWhere(input.guildId, String(input.discordUserId ?? ""), now);

  const existing = await prisma.banRecord.findFirst({
    where,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  if (!existing) {
    return { outcome: "not_found", record: null };
  }

  const removed = await prisma.banRecord.update({
    where: { id: existing.id },
    data: {
      removedAt: now,
      removedByDiscordUserId: input.removedByDiscordUserId,
      removeReason: null,
    },
  });
  return { outcome: "removed", record: removed };
}

export class BanService {
  async addPlayerBan(input: BanTimestampInput & { playerTag: string }): Promise<BanMutationResult> {
    const playerTag = normalizePlayerTag(input.playerTag);
    if (!playerTag) {
      return { outcome: "invalid_target", record: null };
    }

    return upsertActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.PLAYER,
      playerTag,
      reason: input.reason,
      bannedByDiscordUserId: input.bannedByDiscordUserId,
      expiresAt: input.expiresAt ?? null,
      now: input.now,
    });
  }

  async addUserBan(input: BanTimestampInput & { discordUserId: string }): Promise<BanMutationResult> {
    const discordUserId = normalizeDiscordUserId(input.discordUserId);
    if (!discordUserId) {
      return { outcome: "invalid_target", record: null };
    }

    return upsertActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.USER,
      discordUserId,
      reason: input.reason,
      bannedByDiscordUserId: input.bannedByDiscordUserId,
      expiresAt: input.expiresAt ?? null,
      now: input.now,
    });
  }

  async removePlayerBan(input: {
    guildId: string;
    playerTag: string;
    removedByDiscordUserId: string;
    now?: Date;
  }): Promise<BanRemovalResult> {
    const playerTag = normalizePlayerTag(input.playerTag);
    if (!playerTag) {
      return { outcome: "invalid_target", record: null };
    }

    return removeActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.PLAYER,
      playerTag,
      removedByDiscordUserId: input.removedByDiscordUserId,
      now: input.now,
    });
  }

  async removeUserBan(input: {
    guildId: string;
    discordUserId: string;
    removedByDiscordUserId: string;
    now?: Date;
  }): Promise<BanRemovalResult> {
    const discordUserId = normalizeDiscordUserId(input.discordUserId);
    if (!discordUserId) {
      return { outcome: "invalid_target", record: null };
    }

    return removeActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.USER,
      discordUserId,
      removedByDiscordUserId: input.removedByDiscordUserId,
      now: input.now,
    });
  }

  async listActiveBans(input: { guildId: string; now?: Date }): Promise<BanListRecord[]> {
    const now = input.now ?? new Date();
    const rows = await prisma.banRecord.findMany({
      where: {
        guildId: input.guildId,
        removedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const userBanUserIds = [
      ...new Set(
        rows
          .filter((row) => row.targetKind === BanTargetKind.USER)
          .map((row) => normalizeDiscordUserId(row.discordUserId))
          .filter((value): value is string => value !== null),
      ),
    ];

    const linkedTagsByUserId = new Map<string, string[]>();
    for (const discordUserId of userBanUserIds) {
      const links = await listPlayerLinksForDiscordUser({ discordUserId });
      linkedTagsByUserId.set(
        discordUserId,
        [...new Set(links.map((link) => normalizePlayerTag(link.playerTag)).filter(Boolean))],
      );
    }

    return rows.map((row) => ({
      ...row,
      linkedPlayerTags:
        row.targetKind === BanTargetKind.USER
          ? linkedTagsByUserId.get(normalizeDiscordUserId(row.discordUserId) ?? "") ?? []
          : [],
    }));
  }

  async isPlayerBanned(input: {
    guildId: string;
    playerTag: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const playerTag = normalizePlayerTag(input.playerTag);
    if (!playerTag) return false;

    const directBan = await prisma.banRecord.findFirst({
      where: buildPlayerBanWhere(input.guildId, playerTag, now),
      select: { id: true, removedAt: true, expiresAt: true },
    });
    if (directBan && isActiveBanRecord(directBan, now)) {
      return true;
    }

    const linked = await prisma.playerLink.findUnique({
      where: { playerTag },
      select: { discordUserId: true },
    });
    const discordUserId = normalizeDiscordUserId(linked?.discordUserId);
    if (!discordUserId) return false;

    const userBan = await prisma.banRecord.findFirst({
      where: buildUserBanWhere(input.guildId, discordUserId, now),
      select: { id: true, removedAt: true, expiresAt: true },
    });
    return Boolean(userBan && isActiveBanRecord(userBan, now));
  }
}
