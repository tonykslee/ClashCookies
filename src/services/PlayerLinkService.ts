import {
  PlayerLinkSource,
  PlayerLinkVerificationMethod,
  PlayerLinkVerificationStatus,
} from "@prisma/client";
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

export type DiscordUserPlayerLink = {
  playerTag: string;
  linkedAt: Date;
  linkedName: string | null;
};

export type PlayerLinkTrustTier = "verified" | "trusted" | "legacy" | "untrusted" | "revoked";

export type PlayerLinkVerificationOutcome =
  | "verified"
  | "invalid_tag"
  | "invalid_user"
  | "not_found"
  | "not_owner"
  | "invalid_token"
  | "service_error";

export type PlayerLinkWithTrust = {
  playerTag: string;
  discordUserId: string | null;
  discordUsername: string | null;
  playerName: string | null;
  linkSource: PlayerLinkSource;
  verificationStatus: PlayerLinkVerificationStatus;
  verificationMethod: PlayerLinkVerificationMethod | null;
  verifiedAt: Date | null;
  verifiedByDiscordUserId: string | null;
  lastVerifiedAt: Date | null;
  verificationFailureReason: string | null;
  importBatchKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlayerLinkNameBackfillResult = {
  playerTag: string;
  updated: boolean;
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
export function normalizeDiscordUserId(input: unknown): string | null {
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

/** Purpose: normalize persisted in-game player names for deterministic identity fallback use. */
export function normalizePersistedPlayerName(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized;
}

/** Purpose: normalize persisted usernames with a deterministic fallback. */
export function sanitizeDiscordUsernameForPersistence(input: unknown): string {
  return normalizePersistedDiscordUsername(input) ?? PLAYER_LINK_DISCORD_USERNAME_FALLBACK;
}

function normalizePlayerLinkVerificationMethod(
  input: PlayerLinkVerificationMethod | null | undefined,
): PlayerLinkVerificationMethod | null {
  if (input === "PLAYER_API_TOKEN" || input === "ADMIN_OVERRIDE" || input === "IMPORT" || input === "LEGACY") {
    return input;
  }
  return null;
}

function normalizePlayerLinkSource(input: PlayerLinkSource | null | undefined): PlayerLinkSource {
  if (
    input === "SELF_SERVICE" ||
    input === "EMBED_SELF_SERVICE" ||
    input === "ADMIN_CREATE" ||
    input === "IMPORT_CLASHPERK" ||
    input === "LEGACY"
  ) {
    return input;
  }
  return "LEGACY";
}

export function buildPlayerLinkTrustWriteData(input: {
  linkSource: PlayerLinkSource;
  verificationMethod?: PlayerLinkVerificationMethod | null;
  importBatchKey?: string | null;
}): {
  linkSource: PlayerLinkSource;
  verificationStatus: PlayerLinkVerificationStatus;
  verificationMethod: PlayerLinkVerificationMethod | null;
  verifiedAt: null;
  verifiedByDiscordUserId: null;
  lastVerifiedAt: null;
  verificationFailureReason: null;
  importBatchKey: string | null;
} {
  return {
    linkSource: normalizePlayerLinkSource(input.linkSource),
    verificationStatus: "UNVERIFIED" as const,
    verificationMethod: normalizePlayerLinkVerificationMethod(input.verificationMethod),
    verifiedAt: null,
    verifiedByDiscordUserId: null,
    lastVerifiedAt: null,
    verificationFailureReason: null,
    importBatchKey: String(input.importBatchKey ?? "").trim() || null,
  };
}

function normalizePlayerLinkTrustRecord(row: {
  playerTag: string;
  discordUserId: string | null;
  discordUsername: string | null;
  playerName: string | null;
  linkSource: PlayerLinkSource;
  verificationStatus: PlayerLinkVerificationStatus;
  verificationMethod: PlayerLinkVerificationMethod | null;
  verifiedAt: Date | null;
  verifiedByDiscordUserId: string | null;
  lastVerifiedAt: Date | null;
  verificationFailureReason: string | null;
  importBatchKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PlayerLinkWithTrust {
  return {
    playerTag: normalizePlayerTag(row.playerTag),
    discordUserId: normalizeDiscordUserId(row.discordUserId),
    discordUsername: normalizePersistedDiscordUsername(row.discordUsername),
    playerName: normalizePersistedPlayerName(row.playerName),
    linkSource: normalizePlayerLinkSource(row.linkSource),
    verificationStatus: row.verificationStatus,
    verificationMethod: normalizePlayerLinkVerificationMethod(row.verificationMethod),
    verifiedAt: row.verifiedAt ?? null,
    verifiedByDiscordUserId: normalizeDiscordUserId(row.verifiedByDiscordUserId),
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    verificationFailureReason:
      normalizePersistedDiscordUsername(row.verificationFailureReason) ?? null,
    importBatchKey: normalizePersistedDiscordUsername(row.importBatchKey) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isTokenVerifiedLink(link: Pick<
  PlayerLinkWithTrust,
  "verificationStatus" | "verificationMethod"
>): boolean {
  return (
    link.verificationStatus === "VERIFIED" &&
    link.verificationMethod === "PLAYER_API_TOKEN"
  );
}

function isTrustedNonVerifiedSource(link: Pick<PlayerLinkWithTrust, "linkSource">): boolean {
  return (
    link.linkSource === "ADMIN_CREATE" ||
    link.linkSource === "IMPORT_CLASHPERK" ||
    link.linkSource === "LEGACY"
  );
}

function isVerifiedButNotTokenVerifiedLink(link: Pick<
  PlayerLinkWithTrust,
  "verificationStatus" | "verificationMethod"
>): boolean {
  return (
    link.verificationStatus === "VERIFIED" &&
    (link.verificationMethod === "ADMIN_OVERRIDE" || link.verificationMethod === "IMPORT")
  );
}

function isVerifiedOrTrustedLink(link: Pick<
  PlayerLinkWithTrust,
  "linkSource" | "verificationStatus" | "verificationMethod"
>): boolean {
  if (link.verificationStatus === "REVOKED") return false;
  if (isTokenVerifiedLink(link)) return true;
  if (isVerifiedButNotTokenVerifiedLink(link)) return true;
  return isTrustedNonVerifiedSource(link);
}

export function isPlayerLinkVerifiedForAutorole(link: Pick<
  PlayerLinkWithTrust,
  "verificationStatus" | "verificationMethod"
>): boolean {
  return isTokenVerifiedLink(link);
}

export function isPlayerLinkTrustedForAutorole(link: Pick<
  PlayerLinkWithTrust,
  "linkSource" | "verificationStatus" | "verificationMethod"
>): boolean {
  return isVerifiedOrTrustedLink(link);
}

export function getPlayerLinkTrustTier(link: Pick<
  PlayerLinkWithTrust,
  "linkSource" | "verificationStatus" | "verificationMethod"
>): PlayerLinkTrustTier {
  if (link.verificationStatus === "REVOKED") return "revoked";
  if (isTokenVerifiedLink(link)) return "verified";
  if (isVerifiedButNotTokenVerifiedLink(link)) return "trusted";
  if (isTrustedNonVerifiedSource(link)) return link.linkSource === "LEGACY" ? "legacy" : "trusted";
  return "untrusted";
}

export async function markPlayerLinkVerified(input: {
  playerTag: string;
  verifiedByDiscordUserId?: string | null;
  verificationMethod?: PlayerLinkVerificationMethod | null;
}): Promise<boolean> {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) return false;

  const verifiedByDiscordUserId = normalizeDiscordUserId(input.verifiedByDiscordUserId);
  const verifiedAt = new Date();
  const updateResult = await prisma.playerLink.updateMany({
    where: { playerTag: normalizedTag },
    data: {
      verificationStatus: "VERIFIED",
      verificationMethod: normalizePlayerLinkVerificationMethod(
        input.verificationMethod ?? "PLAYER_API_TOKEN",
      ),
      verifiedAt,
      verifiedByDiscordUserId,
      lastVerifiedAt: verifiedAt,
      verificationFailureReason: null,
    },
  });
  return updateResult.count > 0;
}

export async function revokePlayerLinkVerification(input: {
  playerTag: string;
}): Promise<boolean> {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) return false;

  const updateResult = await prisma.playerLink.updateMany({
    where: { playerTag: normalizedTag },
    data: {
      verificationStatus: "REVOKED",
      verificationMethod: null,
      verifiedAt: null,
      verifiedByDiscordUserId: null,
      verificationFailureReason: null,
    },
  });
  return updateResult.count > 0;
}

export async function getPlayerLinksForDiscordUserWithTrust(input: {
  discordUserId: string;
}): Promise<PlayerLinkWithTrust[]> {
  const normalizedUserId = normalizeDiscordUserId(input.discordUserId);
  if (!normalizedUserId) return [];

  const rows = await prisma.playerLink.findMany({
    where: { discordUserId: normalizedUserId },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
      linkSource: true,
      verificationStatus: true,
      verificationMethod: true,
      verifiedAt: true,
      verifiedByDiscordUserId: true,
      lastVerifiedAt: true,
      verificationFailureReason: true,
      importBatchKey: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows
    .map((row) => normalizePlayerLinkTrustRecord(row))
    .filter((row) => row.playerTag.length > 0);
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

  try {
    const trustData = buildPlayerLinkTrustWriteData({
      linkSource: input.selfService ? "SELF_SERVICE" : "ADMIN_CREATE",
    });
    if (existing) {
      const updated = await prisma.playerLink.updateMany({
        where: {
          playerTag: normalizedTag,
          OR: [{ discordUserId: null }, { discordUserId: normalizedUserId }],
        },
        data: {
          discordUserId: normalizedUserId,
          ...trustData,
        },
      });

      if (updated.count <= 0) {
        const racedExisting = await prisma.playerLink.findUnique({
          where: { playerTag: normalizedTag },
          select: { discordUserId: true },
        });
        if (racedExisting?.discordUserId) {
          if (racedExisting.discordUserId === normalizedUserId) {
            return {
              outcome: input.selfService ? "already_linked_to_you" : "already_linked_to_target_user",
              playerTag: normalizedTag,
              discordUserId: normalizedUserId,
              existingDiscordUserId: racedExisting.discordUserId,
            };
          }
          return {
            outcome: "already_linked_to_other_user",
            playerTag: normalizedTag,
            discordUserId: normalizedUserId,
            existingDiscordUserId: racedExisting.discordUserId,
          };
        }

        await prisma.playerLink.create({
          data: {
            playerTag: normalizedTag,
            discordUserId: normalizedUserId,
            ...trustData,
          },
        });
      }
    } else {
      await prisma.playerLink.create({
        data: {
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
          ...trustData,
        },
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code ?? "";
    if (code !== "P2002") throw err;

    const racedExisting = await prisma.playerLink.findUnique({
      where: { playerTag: normalizedTag },
      select: { discordUserId: true },
    });
    if (racedExisting?.discordUserId === normalizedUserId) {
      return {
        outcome: input.selfService ? "already_linked_to_you" : "already_linked_to_target_user",
        playerTag: normalizedTag,
        discordUserId: normalizedUserId,
        existingDiscordUserId: racedExisting.discordUserId,
      };
    }
    return {
      outcome: "already_linked_to_other_user",
      playerTag: normalizedTag,
      discordUserId: normalizedUserId,
      existingDiscordUserId: racedExisting?.discordUserId ?? null,
    };
  }
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
    const trustData = buildPlayerLinkTrustWriteData({
      linkSource: "EMBED_SELF_SERVICE",
    });
    if (existing) {
      await prisma.playerLink.update({
        where: { playerTag: normalizedTag },
        data: {
          discordUserId: normalizedUserId,
          discordUsername: sanitizeDiscordUsernameForPersistence(
            input.submittingDiscordUsername
          ),
          ...trustData,
        },
      });
    } else {
      await prisma.playerLink.create({
        data: {
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
          discordUsername: sanitizeDiscordUsernameForPersistence(
            input.submittingDiscordUsername
          ),
          ...trustData,
        },
      });
    }
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
    where: {
      playerTag: { in: uniqueOrdered },
      discordUserId: { not: null },
    },
    select: { playerTag: true, discordUserId: true, discordUsername: true, createdAt: true },
  });

  const indexByTag = new Map(uniqueOrdered.map((tag, idx) => [tag, idx]));
  return rows
    .map((row) => ({
      playerTag: normalizePlayerTag(row.playerTag),
      discordUserId: normalizeDiscordUserId(row.discordUserId) ?? "",
      discordUsername: normalizePersistedDiscordUsername(row.discordUsername),
      linkedAt: row.createdAt,
    }))
    .filter((row) => row.playerTag.length > 0 && row.discordUserId.length > 0)
    .sort((a, b) => {
      const aIndex = indexByTag.get(a.playerTag);
      const bIndex = indexByTag.get(b.playerTag);
      if (aIndex !== undefined && bIndex !== undefined && aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.playerTag.localeCompare(b.playerTag);
    });
}

/** Purpose: fetch linked player tags for one Discord user in deterministic order. */
export async function listPlayerLinksForDiscordUser(input: {
  discordUserId: string;
}): Promise<DiscordUserPlayerLink[]> {
  const rows = await getPlayerLinksForDiscordUserWithTrust({
    discordUserId: input.discordUserId,
  });
  return rows.map((row) => ({
    playerTag: row.playerTag,
    linkedAt: row.createdAt,
    linkedName: row.playerName,
  }));
}

/** Purpose: persist one linked in-game player name only when PlayerLink.playerName is currently missing. */
export async function backfillPlayerLinkNameIfMissing(input: {
  playerTag: string;
  playerName: string;
}): Promise<PlayerLinkNameBackfillResult> {
  const playerTag = normalizePlayerTag(input.playerTag);
  const playerName = normalizePersistedPlayerName(input.playerName);
  if (!playerTag || !playerName) {
    return { playerTag, updated: false };
  }

  const updateResult = await prisma.playerLink.updateMany({
    where: {
      playerTag,
      OR: [{ playerName: null }, { playerName: "" }],
    },
    data: {
      playerName,
    },
  });
  return { playerTag, updated: updateResult.count > 0 };
}

/** Purpose: fetch current DB weights for provided player tags and return a deterministic lookup. */
export async function listCurrentWeightsForClanMembers(input: {
  memberTagsInOrder: string[];
}): Promise<Map<string, number>> {
  const normalizedOrdered = input.memberTagsInOrder
    .map((tag) => normalizePlayerTag(tag))
    .filter(Boolean);
  if (normalizedOrdered.length === 0) return new Map();

  const uniqueOrdered = [...new Set(normalizedOrdered)];
  const rows = await prisma.fwaClanMemberCurrent.findMany({
    where: { playerTag: { in: uniqueOrdered } },
    select: { playerTag: true, weight: true, sourceSyncedAt: true },
  });

  const latestByTag = new Map<string, { weight: number; sourceSyncedAt: Date }>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const weight =
      row.weight !== null && row.weight !== undefined && Number.isFinite(row.weight)
        ? Math.trunc(row.weight)
        : null;
    if (weight === null) continue;

    const existing = latestByTag.get(playerTag);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latestByTag.set(playerTag, {
        weight,
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }

  return new Map(
    uniqueOrdered
      .map((tag) => [tag, latestByTag.get(tag)?.weight] as const)
      .filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
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
      discordUserId: { not: null },
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
