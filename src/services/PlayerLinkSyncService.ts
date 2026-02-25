import { prisma } from "../prisma";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import { ClashKingService } from "./ClashKingService";
import { SettingsService } from "./SettingsService";

const UNRESOLVED_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNRESOLVED_LAST_SYNC_KEY = "clashking:unresolved_last_sync_ms";

function normalizeTag(input: string): string {
  const trimmed = String(input ?? "").trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizeDiscordUserId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!/^\d{15,22}$/.test(trimmed)) return null;
  return trimmed;
}

export class PlayerLinkSyncService {
  constructor(
    private readonly clashKing = new ClashKingService(),
    private readonly settings = new SettingsService()
  ) {}

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
      const existingSet = new Set(existing.map((e) => normalizeTag(e.playerTag)));
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
        `[clashking] unresolved link sync failed tags=${normalizedTags.length} error=${formatError(err)}`
      );
    }
  }
}

