import { BanRecord, BanTargetKind } from "@prisma/client";
import { prisma } from "../prisma";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";

export type BanMutationOutcome = "created" | "updated" | "invalid_target" | "invalid_clan";
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
  clanTag?: string | null;
  clanName?: string | null;
};

function normalizeBanText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBanReason(input: unknown): string | null {
  return normalizeBanText(input);
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

async function findActiveBanRecord(input: {
  guildId: string;
  targetKind: BanTargetKind;
  playerTag?: string | null;
  discordUserId?: string | null;
  now?: Date;
}): Promise<BanRecord | null> {
  const now = input.now ?? new Date();
  const where =
    input.targetKind === BanTargetKind.PLAYER
      ? buildPlayerBanWhere(input.guildId, String(input.playerTag ?? ""), now)
      : buildUserBanWhere(input.guildId, String(input.discordUserId ?? ""), now);

  return prisma.banRecord.findFirst({
    where,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

async function resolveBanClanContext(input: {
  clanTag?: string | null;
  clanName?: string | null;
}): Promise<{ clanTag: string; clanName: string | null } | null | "invalid_clan"> {
  const rawClanTag = normalizeBanText(input.clanTag);
  if (!rawClanTag) return null;

  const clanTag = normalizeClanTag(rawClanTag);
  if (!clanTag) return "invalid_clan";

  const trackedClan = await prisma.trackedClan.findUnique({
    where: { tag: clanTag },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    return "invalid_clan";
  }

  return {
    clanTag: normalizeClanTag(trackedClan.tag) || clanTag,
    clanName: normalizeBanText(trackedClan.name) ?? normalizeBanText(input.clanName),
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
  clanTag?: string | null;
  clanName?: string | null;
}): Promise<BanMutationResult> {
  const now = input.now ?? new Date();
  const reason = normalizeBanReason(input.reason);
  const expiresAt = input.expiresAt ?? null;
  const clanContext = await resolveBanClanContext({
    clanTag: input.clanTag ?? null,
    clanName: input.clanName ?? null,
  });
  if (clanContext === "invalid_clan") {
    return { outcome: "invalid_clan", record: null };
  }

  const existing = await findActiveBanRecord({
    guildId: input.guildId,
    targetKind: input.targetKind,
    playerTag: input.playerTag ?? null,
    discordUserId: input.discordUserId ?? null,
    now,
  });

  if (existing) {
    const updated = await prisma.banRecord.update({
      where: { id: existing.id },
      data: {
        reason,
        expiresAt,
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
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
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
        reason,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        expiresAt,
      },
    });
    return { outcome: "created", record: created };
  } catch (error) {
    const code = (error as { code?: string } | null | undefined)?.code ?? "";
    if (code !== "P2002") throw error;

    const racedExisting = await findActiveBanRecord({
      guildId: input.guildId,
      targetKind: input.targetKind,
      playerTag: input.playerTag ?? null,
      discordUserId: input.discordUserId ?? null,
      now,
    });
    if (!racedExisting) {
      throw error;
    }

    const updated = await prisma.banRecord.update({
      where: { id: racedExisting.id },
      data: {
        reason,
        expiresAt,
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
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
      clanTag: input.clanTag ?? null,
      clanName: input.clanName ?? null,
    });
  }

  async findActiveBanForPlayer(input: {
    guildId: string;
    playerTag: string;
    now?: Date;
  }): Promise<BanRecord | null> {
    const playerTag = normalizePlayerTag(input.playerTag);
    if (!playerTag) return null;

    const directBan = await findActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.PLAYER,
      playerTag,
      now: input.now,
    });
    if (directBan) return directBan;

    const linked = await prisma.playerLink.findUnique({
      where: { playerTag },
      select: { discordUserId: true },
    });
    const discordUserId = normalizeDiscordUserId(linked?.discordUserId);
    if (!discordUserId) return null;

    return findActiveBanRecord({
      guildId: input.guildId,
      targetKind: BanTargetKind.USER,
      discordUserId,
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
      clanTag: input.clanTag ?? null,
      clanName: input.clanName ?? null,
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
    return Boolean(await this.findActiveBanForPlayer(input));
  }
}
