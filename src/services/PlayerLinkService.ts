import { prisma } from "../prisma";

export type PlayerLinkCreateOutcome =
  | "created"
  | "already_linked_to_you"
  | "already_linked_to_target_user"
  | "already_linked_to_other_user"
  | "invalid_tag"
  | "invalid_user";

export type PlayerLinkDeleteOutcome = "deleted" | "not_found" | "not_owner" | "invalid_tag";

export type PlayerLinkCreateResult = {
  outcome: PlayerLinkCreateOutcome;
  playerTag: string;
  discordUserId: string | null;
  existingDiscordUserId?: string | null;
};

export type PlayerLinkDeleteResult = {
  outcome: PlayerLinkDeleteOutcome;
  playerTag: string;
  existingDiscordUserId?: string | null;
};

export type ClanScopedPlayerLink = {
  playerTag: string;
  discordUserId: string;
  linkedAt: Date;
};

/** Purpose: normalize a player tag into uppercase #TAG format. */
export function normalizePlayerTag(input: string): string {
  const trimmed = String(input ?? "").trim().toUpperCase();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[PYLQGRJCUV0289]{4,15}$/.test(normalized) ? normalized : "";
}

/** Purpose: normalize a clan tag into uppercase #TAG format. */
export function normalizeClanTag(input: string): string {
  const trimmed = String(input ?? "").trim().toUpperCase();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[PYLQGRJCUV0289]{4,15}$/.test(normalized) ? normalized : "";
}

/** Purpose: normalize a Discord user snowflake. */
export function normalizeDiscordUserId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!/^\d{15,22}$/.test(trimmed)) return null;
  return trimmed;
}

/** Purpose: render a linked timestamp in deterministic UTC format. */
export function formatLinkedAtUtc(input: Date): string {
  const year = input.getUTCFullYear();
  const month = String(input.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.getUTCDate()).padStart(2, "0");
  const hour = String(input.getUTCHours()).padStart(2, "0");
  const minute = String(input.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

/** Purpose: create a new player link without implicit reassignment. */
export async function createPlayerLink(input: {
  playerTag: string;
  targetDiscordUserId: string;
  selfService: boolean;
}): Promise<PlayerLinkCreateResult> {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) {
    return { outcome: "invalid_tag", playerTag: "", discordUserId: null };
  }
  const normalizedUserId = normalizeDiscordUserId(input.targetDiscordUserId);
  if (!normalizedUserId) {
    return { outcome: "invalid_user", playerTag: normalizedTag, discordUserId: null };
  }

  const existing = await prisma.playerLink.findUnique({
    where: { playerTag: normalizedTag },
    select: { discordUserId: true },
  });
  if (existing?.discordUserId) {
    if (existing.discordUserId === normalizedUserId) {
      return {
        outcome: input.selfService ? "already_linked_to_you" : "already_linked_to_target_user",
        playerTag: normalizedTag,
        discordUserId: normalizedUserId,
        existingDiscordUserId: existing.discordUserId,
      };
    }
    return {
      outcome: "already_linked_to_other_user",
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
      existingDiscordUserId: existing.discordUserId,
    };
  }

  await prisma.playerLink.create({
    data: {
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
    },
  });
  return {
    outcome: "created",
    playerTag: normalizedTag,
    discordUserId: normalizedUserId,
  };
}

/** Purpose: delete a player link with owner/admin checks. */
export async function deletePlayerLink(input: {
  playerTag: string;
  requestingDiscordUserId: string;
  allowAdminDelete: boolean;
}): Promise<PlayerLinkDeleteResult> {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) return { outcome: "invalid_tag", playerTag: "" };
  const requester = normalizeDiscordUserId(input.requestingDiscordUserId);
  if (!requester) {
    return {
      outcome: "not_owner",
      playerTag: normalizedTag,
    };
  }

  const existing = await prisma.playerLink.findUnique({
    where: { playerTag: normalizedTag },
    select: { discordUserId: true },
  });
  if (!existing?.discordUserId) {
    return { outcome: "not_found", playerTag: normalizedTag };
  }

  const isOwner = existing.discordUserId === requester;
  if (!isOwner && !input.allowAdminDelete) {
    return {
      outcome: "not_owner",
      playerTag: normalizedTag,
      existingDiscordUserId: existing.discordUserId,
    };
  }

  await prisma.playerLink.delete({
    where: { playerTag: normalizedTag },
  });
  return {
    outcome: "deleted",
    playerTag: normalizedTag,
    existingDiscordUserId: existing.discordUserId,
  };
}

/** Purpose: fetch links for a clan member tag set in deterministic order. */
export async function listPlayerLinksForClanMembers(input: {
  memberTagsInOrder: string[];
}): Promise<ClanScopedPlayerLink[]> {
  const normalizedOrdered = input.memberTagsInOrder
    .map((tag) => normalizePlayerTag(tag))
    .filter(Boolean);
  if (normalizedOrdered.length === 0) return [];

  const uniqueOrdered = [...new Set(normalizedOrdered)];
  const rows = await prisma.playerLink.findMany({
    where: { playerTag: { in: uniqueOrdered } },
    select: { playerTag: true, discordUserId: true, createdAt: true },
  });

  const indexByTag = new Map(uniqueOrdered.map((tag, idx) => [tag, idx]));
  return rows
    .map((row) => ({
      playerTag: normalizePlayerTag(row.playerTag),
      discordUserId: String(row.discordUserId),
      linkedAt: row.createdAt,
    }))
    .filter((row) => row.playerTag.length > 0)
    .sort((a, b) => {
      const aIndex = indexByTag.get(a.playerTag);
      const bIndex = indexByTag.get(b.playerTag);
      if (aIndex !== undefined && bIndex !== undefined && aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.playerTag.localeCompare(b.playerTag);
    });
}
