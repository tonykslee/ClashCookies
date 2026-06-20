import { BanRecord, BanTargetKind } from "@prisma/client";
import { prisma } from "../prisma";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePersistedDiscordUsername,
  normalizePersistedPlayerName,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { type BanDisplayRecord } from "./BanDisplayService";

export type BanMutationOutcome = "created" | "updated" | "invalid_target" | "invalid_clan";
export type BanRemovalOutcome = "removed" | "not_found" | "invalid_target";

export type BanMutationResult = {
  outcome: BanMutationOutcome;
  record: BanDisplayRecord | null;
};

export type BanRemovalResult = {
  outcome: BanRemovalOutcome;
  record: BanDisplayRecord | null;
};

export type BanListRecord = BanRecord & {
  linkedPlayerTags: string[];
  targetPlayerName: string | null;
};

type BanTimestampInput = {
  guildId: string;
  reason?: string | null;
  bannedByDiscordUserId: string;
  expiresAt?: Date | null;
  now?: Date;
  clanTag?: string | null;
  clanName?: string | null;
  targetDiscordUsername?: string | null;
  targetDiscordDisplayName?: string | null;
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

async function loadBanDisplayData(input: {
  playerTags?: string[];
  discordUserIds?: string[];
}): Promise<{
  targetPlayerNameByTag: Map<string, string | null>;
  linkedPlayerTagsByUserId: Map<string, string[]>;
}> {
  const playerTags = [...new Set((input.playerTags ?? []).map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  const discordUserIds = [...new Set((input.discordUserIds ?? []).map((userId) => normalizeDiscordUserId(userId)).filter((value): value is string => value !== null))];

  if (playerTags.length === 0 && discordUserIds.length === 0) {
    return {
      targetPlayerNameByTag: new Map(),
      linkedPlayerTagsByUserId: new Map(),
    };
  }

  const [playerCurrentRows, playerLinkRows] = await Promise.all([
    playerTags.length > 0
      ? prisma.playerCurrent.findMany({
          where: { playerTag: { in: playerTags } },
          select: { playerTag: true, playerName: true },
        })
      : Promise.resolve([]),
    playerTags.length > 0 || discordUserIds.length > 0
      ? prisma.playerLink.findMany({
          where:
            playerTags.length > 0 && discordUserIds.length > 0
              ? {
                  OR: [
                    { playerTag: { in: playerTags } },
                    { discordUserId: { in: discordUserIds } },
                  ],
                }
              : playerTags.length > 0
                ? { playerTag: { in: playerTags } }
                : { discordUserId: { in: discordUserIds } },
          orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
          select: { playerTag: true, discordUserId: true, playerName: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const currentNameByTag = new Map<string, string | null>();
  for (const row of playerCurrentRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    currentNameByTag.set(playerTag, normalizePersistedPlayerName(row.playerName));
  }

  const fallbackNameByTag = new Map<string, string | null>();
  const linkedPlayerTagsByUserId = new Map<string, string[]>();
  for (const row of playerLinkRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (playerTag && playerTags.includes(playerTag) && !fallbackNameByTag.has(playerTag)) {
      fallbackNameByTag.set(playerTag, normalizePersistedPlayerName(row.playerName));
    }

    const discordUserId = normalizeDiscordUserId(row.discordUserId);
    if (!discordUserId || !discordUserIds.includes(discordUserId) || !playerTag) continue;
    const tags = linkedPlayerTagsByUserId.get(discordUserId) ?? [];
    tags.push(playerTag);
    linkedPlayerTagsByUserId.set(discordUserId, tags);
  }

  const targetPlayerNameByTag = new Map<string, string | null>();
  for (const playerTag of playerTags) {
    targetPlayerNameByTag.set(playerTag, currentNameByTag.get(playerTag) ?? fallbackNameByTag.get(playerTag) ?? null);
  }

  return {
    targetPlayerNameByTag,
    linkedPlayerTagsByUserId,
  };
}

async function enrichBanRecordForDisplay(record: BanRecord): Promise<BanDisplayRecord> {
  if (record.targetKind !== BanTargetKind.PLAYER) {
    return {
      ...record,
      linkedPlayerTags: [],
      targetPlayerName: null,
    };
  }

  const playerTag = normalizePlayerTag(record.playerTag ?? "");
  if (!playerTag) {
    return {
      ...record,
      linkedPlayerTags: [],
      targetPlayerName: null,
    };
  }

  const { targetPlayerNameByTag } = await loadBanDisplayData({
    playerTags: [playerTag],
  });

  return {
    ...record,
    linkedPlayerTags: [],
    targetPlayerName: targetPlayerNameByTag.get(playerTag) ?? null,
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
  targetDiscordUsername?: string | null;
  targetDiscordDisplayName?: string | null;
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
        targetDiscordUsername:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordUsername)
            : null,
        targetDiscordDisplayName:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordDisplayName)
            : null,
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
      },
    });
    return {
      outcome: "updated",
      record: await enrichBanRecordForDisplay(updated),
    };
  }

  try {
    const created = await prisma.banRecord.create({
      data: {
        guildId: input.guildId,
        targetKind: input.targetKind,
        playerTag: input.playerTag ?? null,
        discordUserId: input.discordUserId ?? null,
        targetDiscordUsername:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordUsername)
            : null,
        targetDiscordDisplayName:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordDisplayName)
            : null,
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
        reason,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        expiresAt,
      },
    });
    return {
      outcome: "created",
      record: await enrichBanRecordForDisplay(created),
    };
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
        targetDiscordUsername:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordUsername)
            : null,
        targetDiscordDisplayName:
          input.targetKind === BanTargetKind.USER
            ? normalizePersistedDiscordUsername(input.targetDiscordDisplayName)
            : null,
        clanTag: clanContext?.clanTag ?? null,
        clanName: clanContext?.clanName ?? null,
        bannedByDiscordUserId: input.bannedByDiscordUserId,
        removedAt: null,
        removedByDiscordUserId: null,
        removeReason: null,
      },
    });
    return {
      outcome: "updated",
      record: await enrichBanRecordForDisplay(updated),
    };
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
  return {
    outcome: "removed",
    record: await enrichBanRecordForDisplay(removed),
  };
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
      targetDiscordUsername: null,
      targetDiscordDisplayName: null,
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
      targetDiscordUsername: input.targetDiscordUsername ?? null,
      targetDiscordDisplayName: input.targetDiscordDisplayName ?? null,
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

    const playerTags = [
      ...new Set(
        rows
          .filter((row) => row.targetKind === BanTargetKind.PLAYER)
          .map((row) => normalizePlayerTag(row.playerTag ?? ""))
          .filter((value): value is string => value !== null),
      ),
    ];
    const discordUserIds = [
      ...new Set(
        rows
          .filter((row) => row.targetKind === BanTargetKind.USER)
          .map((row) => normalizeDiscordUserId(row.discordUserId))
          .filter((value): value is string => value !== null),
      ),
    ];

    const { targetPlayerNameByTag, linkedPlayerTagsByUserId } = await loadBanDisplayData({
      playerTags,
      discordUserIds,
    });

    return rows.map((row) => {
      const playerTag = normalizePlayerTag(row.playerTag ?? "");
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      return {
        ...row,
        linkedPlayerTags:
          row.targetKind === BanTargetKind.USER && discordUserId
            ? linkedPlayerTagsByUserId.get(discordUserId) ?? []
            : [],
        targetPlayerName:
          row.targetKind === BanTargetKind.PLAYER && playerTag
            ? targetPlayerNameByTag.get(playerTag) ?? null
            : null,
      };
    });
  }

  async isPlayerBanned(input: {
    guildId: string;
    playerTag: string;
    now?: Date;
  }): Promise<boolean> {
    return Boolean(await this.findActiveBanForPlayer(input));
  }
}
