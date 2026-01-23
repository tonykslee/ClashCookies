import { CoCService } from "./CoCService";
import { prisma } from "../prisma";

export class SnapshotService {
  constructor(private coc: CoCService) {}

  async snapshotClan(clanTag: string) {
    const clan = await this.coc.getClan(clanTag);

    for (const member of clan.members) {
      const player = await this.coc.getPlayerRaw(member.tag);

      await prisma.playerSnapshot.create({
        data: {
          tag: player.tag,
          name: player.name,
          clanTag: clan.tag,
          trophies: player.trophies,
          donations: player.donations,
          warStars: player.warStars,
          builderTrophies: player.builderBaseTrophies ?? 0,
          capitalGold: player.clanCapitalContributions ?? 0,
        },
      });
    }
  }
}
