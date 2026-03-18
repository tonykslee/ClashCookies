import { prisma } from "../prisma";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import { ClashKingService } from "./ClashKingService";
import { SettingsService } from "./SettingsService";
import axios from "axios";
import { normalizePersistedDiscordUsername } from "./PlayerLinkService";

const UNRESOLVED_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNRESOLVED_LAST_SYNC_KEY = "clashking:unresolved_last_sync_ms";

/** Purpose: normalize tag. */
function normalizeTag(input: string): string {
  const trimmed = String(input ?? "")
    .trim()
    .toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** Purpose: normalize discord user id. */
function normalizeDiscordUserId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!/^\d{15,22}$/.test(trimmed)) return null;
  return trimmed;
}

type PublicGoogleSheetIdentity = {
  sheetId: string;
  gid: string | null;
};

export type PublicGoogleSheetPlayerLinkSyncResult = {
  totalRowCount: number;
  eligibleRowCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  duplicateTagCount: number;
  missingRequiredCount: number;
  invalidTagCount: number;
  invalidDiscordUserIdCount: number;
};

type ClashPerkColumnIndexes = {
  displayName: number;
  username: number;
  id: number;
  tag: number;
};

function extractPublicGoogleSheetIdentity(
  input: string,
): PublicGoogleSheetIdentity {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new Error("Google Sheet URL is required.");
  }

  const directMatch = trimmed.match(/^[a-zA-Z0-9-_]{20,}$/);
  if (directMatch) {
    return { sheetId: trimmed, gid: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid Google Sheet URL.");
  }

  const match = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match?.[1]) {
    throw new Error("Invalid Google Sheet URL.");
  }

  return {
    sheetId: match[1],
    gid: parsed.searchParams.get("gid"),
  };
}

function buildPublicGoogleSheetTsvUrl(
  identity: PublicGoogleSheetIdentity,
): string {
  const params = new URLSearchParams({ format: "tsv" });
  if (identity.gid) params.set("gid", identity.gid);

  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(identity.sheetId)}/export?${params.toString()}`;
}

function parseTsv(text: string): string[][] {
  const normalized = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/).filter((line) => line.length > 0);

  return lines.map((line) => line.split("\t").map((cell) => cell.trim()));
}

function resolveClashPerkColumnIndexes(
  headerRow: string[],
): ClashPerkColumnIndexes {
  const normalized = headerRow.map((cell) => cell.trim().toLowerCase());

  const displayName = normalized.indexOf("displayname");
  const username = normalized.indexOf("username");
  const id = normalized.indexOf("id");
  const tag = normalized.indexOf("tag");

  if (displayName === -1)
    throw new Error("Missing required ClashPerk column: DisplayName");
  if (username === -1)
    throw new Error("Missing required ClashPerk column: Username");
  if (id === -1) throw new Error("Missing required ClashPerk column: ID");
  if (tag === -1) throw new Error("Missing required ClashPerk column: Tag");

  return { displayName, username, id, tag };
}

function getCell(row: string[], index: number): string {
  return String(row[index] ?? "").trim();
}

export class PlayerLinkSyncService {
  /** Purpose: initialize service dependencies. */
  constructor(
    private readonly clashKing = new ClashKingService(),
    private readonly settings = new SettingsService(),
  ) {}

  /** Purpose: sync by discord user id. */
  async syncByDiscordUserId(discordUserId: string): Promise<number> {
    const normalizedId = normalizeDiscordUserId(discordUserId);
    if (!normalizedId) return 0;

    const links = await this.clashKing.lookupLinks([normalizedId]);
    if (links.size === 0) return 0;

    let upserted = 0;
    for (const [rawTag, rawUserId] of links.entries()) {
      const tag = normalizeTag(rawTag);
      if (!tag) continue;
      const userId = normalizeDiscordUserId(rawUserId ?? normalizedId);
      if (!userId) continue;

      await prisma.playerLink.upsert({
        where: { playerTag: tag },
        update: { discordUserId: userId },
        create: { playerTag: tag, discordUserId: userId },
      });
      upserted += 1;
    }

    return upserted;
  }

  /** Purpose: sync missing PlayerLink rows from a public Google Sheet export. */
  async syncFromPublicGoogleSheet(
    input: string,
  ): Promise<PublicGoogleSheetPlayerLinkSyncResult> {
    const identity = extractPublicGoogleSheetIdentity(input);
    const exportUrl = buildPublicGoogleSheetTsvUrl(identity);

    const response = await axios.get<string>(exportUrl, {
      responseType: "text",
      timeout: 15000,
    });

    const rows = parseTsv(response.data);
    if (rows.length === 0) {
      return {
        totalRowCount: 0,
        eligibleRowCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        duplicateTagCount: 0,
        missingRequiredCount: 0,
        invalidTagCount: 0,
        invalidDiscordUserIdCount: 0,
      };
    }

    const [headerRow, ...dataRows] = rows;
    const indexes = resolveClashPerkColumnIndexes(headerRow);

    let missingRequiredCount = 0;
    let invalidTagCount = 0;
    let invalidDiscordUserIdCount = 0;
    let duplicateTagCount = 0;

    const candidateByTag = new Map<
      string,
      {
        playerTag: string;
        discordUserId: string;
        discordUsername: string | null;
      }
    >();

    for (const row of dataRows) {
      const rawTag = getCell(row, indexes.tag);
      const rawDiscordUserId = getCell(row, indexes.id);

      const discordUsername =
        normalizePersistedDiscordUsername(getCell(row, indexes.displayName)) ??
        normalizePersistedDiscordUsername(getCell(row, indexes.username));

      if (!rawTag || !rawDiscordUserId || !discordUsername) {
        missingRequiredCount += 1;
        continue;
      }

      const playerTag = normalizeTag(rawTag);
      if (!playerTag) {
        invalidTagCount += 1;
        continue;
      }

      const discordUserId = normalizeDiscordUserId(rawDiscordUserId);
      if (!discordUserId) {
        invalidDiscordUserIdCount += 1;
        continue;
      }

      if (candidateByTag.has(playerTag)) {
        duplicateTagCount += 1;
        continue;
      }

      candidateByTag.set(playerTag, {
        playerTag,
        discordUserId,
        discordUsername,
      });
    }

    const candidates = [...candidateByTag.values()];
    if (candidates.length === 0) {
      return {
        totalRowCount: dataRows.length,
        eligibleRowCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        duplicateTagCount,
        missingRequiredCount,
        invalidTagCount,
        invalidDiscordUserIdCount,
      };
    }

    let insertedCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;

    const existingRows = await prisma.playerLink.findMany({
      where: {
        playerTag: {
          in: candidates.map((row) => row.playerTag),
        },
      },
      select: {
        playerTag: true,
        discordUserId: true,
        discordUsername: true,
      },
    });

    const existingByTag = new Map(
      existingRows.map((row) => [normalizeTag(row.playerTag), row]),
    );

    for (const row of candidates) {
      const existing = existingByTag.get(row.playerTag);

      if (!existing) {
        await prisma.playerLink.create({
          data: {
            playerTag: row.playerTag,
            discordUserId: row.discordUserId,
            discordUsername: row.discordUsername,
          },
        });
        insertedCount += 1;
        continue;
      }

      const existingDiscordUserId = String(existing.discordUserId ?? "").trim();
      const existingDiscordUsername = normalizePersistedDiscordUsername(
        existing.discordUsername,
      );

      const isSameDiscordUserId = existingDiscordUserId === row.discordUserId;
      const isSameDiscordUsername =
        existingDiscordUsername === row.discordUsername;

      if (isSameDiscordUserId && isSameDiscordUsername) {
        unchangedCount += 1;
        continue;
      }

      await prisma.playerLink.update({
        where: { playerTag: row.playerTag },
        data: {
          discordUserId: row.discordUserId,
          discordUsername: row.discordUsername,
        },
      });
      updatedCount += 1;
    }

    return {
      totalRowCount: dataRows.length,
      eligibleRowCount: candidates.length,
      insertedCount,
      updatedCount,
      unchangedCount,
      duplicateTagCount,
      missingRequiredCount,
      invalidTagCount,
      invalidDiscordUserIdCount,
    };
  }

  /** Purpose: sync missing tags if due. */
  async syncMissingTagsIfDue(tags: string[]): Promise<void> {
    const normalizedTags = [...new Set(tags.map(normalizeTag).filter(Boolean))];
    if (normalizedTags.length === 0) return;

    const now = Date.now();
    const rawLastSync = await this.settings.get(UNRESOLVED_LAST_SYNC_KEY);
    const lastSyncMs = Number(rawLastSync ?? "");
    const isDue =
      !Number.isFinite(lastSyncMs) ||
      lastSyncMs <= 0 ||
      now - lastSyncMs >= UNRESOLVED_SYNC_INTERVAL_MS;

    if (!isDue) {
      recordFetchEvent({
        namespace: "clashking",
        operation: "discord_links_missing_scan",
        source: "cache_hit",
        detail: `skipped=true tags=${normalizedTags.length}`,
      });
      return;
    }

    try {
      const existing = await prisma.playerLink.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: { playerTag: true },
      });
      const existingSet = new Set(
        existing.map((e) => normalizeTag(e.playerTag)),
      );
      const unresolved = normalizedTags.filter((tag) => !existingSet.has(tag));

      if (unresolved.length === 0) {
        recordFetchEvent({
          namespace: "clashking",
          operation: "discord_links_missing_scan",
          source: "cache_miss",
          detail: `tags=${normalizedTags.length} unresolved=0`,
        });
        await this.settings.set(UNRESOLVED_LAST_SYNC_KEY, String(now));
        return;
      }

      const links = await this.clashKing.lookupLinks(unresolved);
      let upserted = 0;
      for (const [rawTag, rawUserId] of links.entries()) {
        const tag = normalizeTag(rawTag);
        const userId = normalizeDiscordUserId(rawUserId ?? "");
        if (!tag || !userId) continue;
        await prisma.playerLink.upsert({
          where: { playerTag: tag },
          update: { discordUserId: userId },
          create: { playerTag: tag, discordUserId: userId },
        });
        upserted += 1;
      }

      recordFetchEvent({
        namespace: "clashking",
        operation: "discord_links_missing_scan",
        source: "cache_miss",
        detail: `tags=${normalizedTags.length} unresolved=${unresolved.length} upserted=${upserted}`,
      });
      await this.settings.set(UNRESOLVED_LAST_SYNC_KEY, String(now));
    } catch (err) {
      console.warn(
        `[clashking] unresolved link sync failed tags=${normalizedTags.length} error=${formatError(err)}`,
      );
    }
  }
}
