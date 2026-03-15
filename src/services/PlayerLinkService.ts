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

export type PlayerLinkEmbedCreateOutcome =
  | "created"
  | "already_linked"
  | "invalid_tag"
  | "invalid_user";

export type PlayerLinkEmbedCreateResult = {
  outcome: PlayerLinkEmbedCreateOutcome;
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
  discordUsername: string | null;
  linkedAt: Date;
};

export const PLAYER_LINK_DISCORD_USERNAME_FALLBACK = "unknown";

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

/** Purpose: normalize persisted discord usernames to a deterministic text form. */
export function normalizePersistedDiscordUsername(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized;
}

/** Purpose: normalize persisted usernames with a deterministic fallback. */
export function sanitizeDiscordUsernameForPersistence(input: unknown): string {
  return normalizePersistedDiscordUsername(input) ?? PLAYER_LINK_DISCORD_USERNAME_FALLBACK;
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

/** Purpose: create link via embed self-service with delete-first conflict behavior. */
export async function createPlayerLinkFromEmbed(input: {
  playerTag: string;
  submittingDiscordUserId: string;
  submittingDiscordUsername: string;
}): Promise<PlayerLinkEmbedCreateResult> {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) {
    return { outcome: "invalid_tag", playerTag: "", discordUserId: null };
  }
  const normalizedUserId = normalizeDiscordUserId(input.submittingDiscordUserId);
  if (!normalizedUserId) {
    return { outcome: "invalid_user", playerTag: normalizedTag, discordUserId: null };
  }

  const existing = await prisma.playerLink.findUnique({
    where: { playerTag: normalizedTag },
    select: { discordUserId: true },
  });
  if (existing?.discordUserId) {
    return {
      outcome: "already_linked",
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
      existingDiscordUserId: existing.discordUserId,
    };
  }

  try {
    await prisma.playerLink.create({
      data: {
        playerTag: normalizedTag,
        discordUserId: normalizedUserId,
        discordUsername: sanitizeDiscordUsernameForPersistence(
          input.submittingDiscordUsername
        ),
      },
    });
    return {
      outcome: "created",
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
    };
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code ?? "";
    if (code !== "P2002") throw err;

    const racedExisting = await prisma.playerLink.findUnique({
      where: { playerTag: normalizedTag },
      select: { discordUserId: true },
    });
    return {
      outcome: "already_linked",
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
      existingDiscordUserId: racedExisting?.discordUserId ?? null,
    };
  }
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
    select: { playerTag: true, discordUserId: true, discordUsername: true, createdAt: true },
  });

  const indexByTag = new Map(uniqueOrdered.map((tag, idx) => [tag, idx]));
  return rows
    .map((row) => ({
      playerTag: normalizePlayerTag(row.playerTag),
      discordUserId: String(row.discordUserId),
      discordUsername: normalizePersistedDiscordUsername(row.discordUsername),
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

export type PlayerLinkDiscordUsernameBackfillResult = {
  candidateLinks: number;
  uniqueUsers: number;
  resolvedUsers: number;
  updatedLinks: number;
};

/** Purpose: fill missing PlayerLink.discordUsername values for observed clan members. */
export async function backfillMissingDiscordUsernamesForClanMembers(input: {
  memberTagsInOrder: string[];
  resolveDiscordUsername: (discordUserId: string) => Promise<string | null>;
}): Promise<PlayerLinkDiscordUsernameBackfillResult> {
  const normalizedOrdered = input.memberTagsInOrder
    .map((tag) => normalizePlayerTag(tag))
    .filter(Boolean);
  if (normalizedOrdered.length === 0) {
    return { candidateLinks: 0, uniqueUsers: 0, resolvedUsers: 0, updatedLinks: 0 };
  }

  const uniqueOrdered = [...new Set(normalizedOrdered)];
  const candidateLinks = await prisma.playerLink.findMany({
    where: {
      playerTag: { in: uniqueOrdered },
      OR: [{ discordUsername: null }, { discordUsername: "" }],
    },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
    },
  });
  if (candidateLinks.length === 0) {
    return { candidateLinks: 0, uniqueUsers: 0, resolvedUsers: 0, updatedLinks: 0 };
  }

  const uniqueUserIds = [
    ...new Set(
      candidateLinks
        .map((row) => normalizeDiscordUserId(row.discordUserId))
        .filter((value): value is string => value !== null)
    ),
  ];

  const usernameByUserId = new Map<string, string>();
  for (const discordUserId of uniqueUserIds) {
    const resolved = normalizePersistedDiscordUsername(
      await input.resolveDiscordUsername(discordUserId)
    );
    if (!resolved) continue;
    usernameByUserId.set(discordUserId, resolved);
  }

  let updatedLinks = 0;
  for (const row of candidateLinks) {
    const discordUserId = normalizeDiscordUserId(row.discordUserId);
    if (!discordUserId) continue;

    const resolvedUsername = usernameByUserId.get(discordUserId);
    if (!resolvedUsername) continue;

    const updateResult = await prisma.playerLink.updateMany({
      where: {
        playerTag: row.playerTag,
        OR: [{ discordUsername: null }, { discordUsername: "" }],
      },
      data: {
        discordUsername: resolvedUsername,
      },
    });
    updatedLinks += updateResult.count;
  }

  return {
    candidateLinks: candidateLinks.length,
    uniqueUsers: uniqueUserIds.length,
    resolvedUsers: usernameByUserId.size,
    updatedLinks,
  };
}
