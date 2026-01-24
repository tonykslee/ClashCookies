import { CoCService } from "./CoCService";
import { prisma } from "../prisma";

export class ActivityService {
  constructor(private coc: CoCService) {}

  /**
   * Observe all members of a clan and update activity signals.
   */
  async observeClan(clanTag: string) {
    const clan = await this.coc.getClan(clanTag);
    const now = new Date();

    for (const member of clan.members) {
      const player = await this.coc.getPlayerRaw(member.tag);

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

    // 🎁 Donations (season-based, non-zero proves login)
    if (input.donations > 0) {
      updates.lastDonationAt = input.now;
    }

    // 🏛 Capital gold (raid weekend proof)
    if (input.capitalGold > 0) {
      updates.lastCapitalAt = input.now;
    }

    // 🏆 Home village trophies (delta-based)
    if (!existing || input.trophies !== (existing as any).lastTrophies) {
      updates.lastTrophyAt = input.now;
      updates.lastTrophies = input.trophies;
    }

    // ⚔️ War stars (monotonic increase)
    if (!existing || input.warStars > (existing as any).lastWarStars) {
      updates.lastWarAt = input.now;
      updates.lastWarStars = input.warStars;
    }

    // 🛠 Builder base
    if (
      !existing ||
      input.builderTrophies !== (existing as any).lastBuilderTrophies
    ) {
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
      updates.lastSeenAt = new Date(
        Math.max(...timestamps.map(d => d.getTime()))
      );
    }
    

    // 🧠 Upsert (single row per player)
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
