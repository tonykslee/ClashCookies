import { prisma } from "../prisma";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { CoCService } from "./CoCService";
import { ActivitySignalService } from "./ActivitySignalService";

export class ActivityService {
  private readonly signalService = new ActivitySignalService();

  /** Purpose: initialize service dependencies. */
  constructor(private coc: CoCService) {}

  /**
   * Observe all members of a clan and update activity signals.
   */
  async observeClan(clanTag: string): Promise<string[]> {
    const clan = await this.coc.getClan(clanTag);
    const now = new Date();
    let playerApiCalls = 0;
    let playersMissing = 0;
    const observedTags: string[] = [];

    for (const member of clan.members) {
      if (member?.tag) {
        observedTags.push(String(member.tag));
      }
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
        donationsReceived: player.donationsReceived ?? 0,
        warStars: player.warStars,
        builderTrophies: player.builderBaseTrophies ?? 0,
        capitalGold: player.clanCapitalContributions ?? 0,
        attackWins: player.attackWins ?? 0,
        defenseWins: player.defenseWins ?? 0,
        versusBattleWins: player.versusBattleWins ?? 0,
        expLevel: player.expLevel ?? 0,
        achievements: Array.isArray(player.achievements) ? player.achievements : [],
        troops: Array.isArray(player.troops) ? player.troops : [],
        heroes: Array.isArray(player.heroes) ? player.heroes : [],
        spells: Array.isArray(player.spells) ? player.spells : [],
        pets: Array.isArray(player.pets) ? player.pets : [],
        heroEquipment: Array.isArray(player.heroEquipment) ? player.heroEquipment : [],
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

    return observedTags;
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
    donationsReceived: number;
    warStars: number;
    builderTrophies: number;
    capitalGold: number;
    attackWins: number;
    defenseWins: number;
    versusBattleWins: number;
    expLevel: number;
    achievements: unknown[];
    troops: unknown[];
    heroes: unknown[];
    spells: unknown[];
    pets: unknown[];
    heroEquipment: unknown[];
    now: Date;
  }) {
    const existing = await prisma.playerActivity.findUnique({
      where: { tag: input.tag },
    });

    const updates: any = {
      name: input.name,
      clanTag: input.clanTag,
    };

    const processed = await this.signalService.processPlayer({
      tag: input.tag,
      name: input.name,
      clanTag: input.clanTag,
      donations: input.donations,
      donationsReceived: input.donationsReceived,
      capitalGold: input.capitalGold,
      trophies: input.trophies,
      builderTrophies: input.builderTrophies,
      warStars: input.warStars,
      attackWins: input.attackWins,
      defenseWins: input.defenseWins,
      versusBattleWins: input.versusBattleWins,
      expLevel: input.expLevel,
      achievements: input.achievements,
      troops: input.troops,
      heroes: input.heroes,
      spells: input.spells,
      pets: input.pets,
      heroEquipment: input.heroEquipment,
      nowMs: input.now.getTime(),
    });

    const signalTimes = processed.state.signalTimes;
    if (signalTimes.donations) {
      updates.lastDonationAt = new Date(signalTimes.donations);
    }
    if (signalTimes.capitalGold) {
      updates.lastCapitalAt = new Date(signalTimes.capitalGold);
    }
    if (signalTimes.trophies) {
      updates.lastTrophyAt = new Date(signalTimes.trophies);
    }
    if (signalTimes.warStars) {
      updates.lastWarAt = new Date(signalTimes.warStars);
    }
    if (signalTimes.builderTrophies) {
      updates.lastBuilderAt = new Date(signalTimes.builderTrophies);
    }

    updates.lastTrophies = input.trophies;
    updates.lastWarStars = input.warStars;
    updates.lastBuilderTrophies = input.builderTrophies;

    const timestamps = [
      updates.lastDonationAt ?? existing?.lastDonationAt,
      updates.lastCapitalAt ?? existing?.lastCapitalAt,
      updates.lastTrophyAt ?? existing?.lastTrophyAt,
      updates.lastWarAt ?? existing?.lastWarAt,
      updates.lastBuilderAt ?? existing?.lastBuilderAt,
      processed.lastSeenAtMs ? new Date(processed.lastSeenAtMs) : null,
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
