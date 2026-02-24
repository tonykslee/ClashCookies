import { prisma } from "../prisma";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { CoCService } from "./CoCService";

export class ActivityService {
  constructor(private coc: CoCService) {}

  /**
   * Observe all members of a clan and update activity signals.
   */
  async observeClan(clanTag: string) {
    const clan = await this.coc.getClan(clanTag);
    const now = new Date();
    let playerApiCalls = 0;
    let playersMissing = 0;

    for (const member of clan.members) {
      playerApiCalls += 1;
      const player = await this.coc.getPlayerRaw(member.tag, { suppressTelemetry: true });
      if (!player) {
        playersMissing += 1;
        continue;
      }

      await this.observePlayer({
        tag: player.tag,
        name: player.name,
        clanTag: clan.tag,
        trophies: player.trophies,
        donations: player.donations,
        warStars: player.warStars,
        builderTrophies: player.builderBaseTrophies ?? 0,
        capitalGold: player.clanCapitalContributions ?? 0,
        now,
      });
    }

    if (playerApiCalls > 0) {
      recordFetchEvent({
        namespace: "coc",
        operation: "getPlayerRaw",
        source: "api",
        incrementBy: playerApiCalls,
        detail: `mode=observeClan clan=${clan.tag} calls=${playerApiCalls} missing=${playersMissing}`,
      });
    }
  }

  /**
   * Update activity signals for a single player.
   */
  private async observePlayer(input: {
    tag: string;
    name: string;
    clanTag: string;
    trophies: number;
    donations: number;
    warStars: number;
    builderTrophies: number;
    capitalGold: number;
    now: Date;
  }) {
    const existing = await prisma.playerActivity.findUnique({
      where: { tag: input.tag },
    });

    const updates: any = {
      name: input.name,
      clanTag: input.clanTag,
    };

    // Prevent restart-driven false positives: do not stamp "now" every poll
    // just because seasonal counters are non-zero.
    if (input.donations > 0 && (!existing || !existing.lastDonationAt)) {
      updates.lastDonationAt = input.now;
    }

    if (input.capitalGold > 0 && (!existing || !existing.lastCapitalAt)) {
      updates.lastCapitalAt = input.now;
    }

    if (!existing || input.trophies !== existing.lastTrophies) {
      updates.lastTrophyAt = input.now;
      updates.lastTrophies = input.trophies;
    }

    if (!existing || input.warStars > (existing.lastWarStars ?? -1)) {
      updates.lastWarAt = input.now;
      updates.lastWarStars = input.warStars;
    }

    if (!existing || input.builderTrophies !== existing.lastBuilderTrophies) {
      updates.lastBuilderAt = input.now;
      updates.lastBuilderTrophies = input.builderTrophies;
    }

    const timestamps = [
      updates.lastDonationAt ?? existing?.lastDonationAt,
      updates.lastCapitalAt ?? existing?.lastCapitalAt,
      updates.lastTrophyAt ?? existing?.lastTrophyAt,
      updates.lastWarAt ?? existing?.lastWarAt,
      updates.lastBuilderAt ?? existing?.lastBuilderAt,
    ].filter(Boolean) as Date[];

    if (timestamps.length > 0) {
      updates.lastSeenAt = new Date(Math.max(...timestamps.map((d) => d.getTime())));
    } else if (!existing) {
      updates.lastSeenAt = input.now;
    }

    await prisma.playerActivity.upsert({
      where: { tag: input.tag },
      update: updates,
      create: {
        tag: input.tag,
        ...updates,
      },
    });
  }
}
