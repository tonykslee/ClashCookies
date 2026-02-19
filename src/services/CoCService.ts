import { AxiosError } from "axios";
import {
  ClansApi,
  Configuration,
  Player,
  PlayersApi,
} from "../generated/coc-api";

export class CoCService {
  private clansApi: ClansApi;
  private playersApi: PlayersApi;

  constructor() {
    const token = process.env.COC_API_TOKEN?.trim();
    if (!token) throw new Error("COC_API_TOKEN missing");

    const config = new Configuration({
      apiKey: `Bearer ${token}`,
      basePath: process.env.COC_API_BASE_URL ?? "https://api.clashofclans.com/v1",
    });

    this.clansApi = new ClansApi(config);
    this.playersApi = new PlayersApi(config);
  }

  async getClan(tag: string): Promise<any> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const { data } = await this.clansApi.getClan(clanTag);

    // Preserve existing call sites that expect `clan.members`.
    return {
      ...data,
      tag: data.tag ?? "",
      name: data.name ?? "Unknown Clan",
      members: data.memberList ?? [],
    };
  }

  async getClanName(tag: string): Promise<string> {
    const clan = await this.getClan(tag);
    return clan.name ?? "Unknown Clan";
  }

  async getPlayerRaw(tag: string | undefined): Promise<any> {
    if (!tag) return null;
    const playerTag = tag.startsWith("#") ? tag : `#${tag}`;

    try {
      const { data } = await this.playersApi.getPlayer(playerTag);
      return this.normalizePlayer(data);
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      if (status === 404) return null;
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  private normalizePlayer(player: Player): any {
    return {
      ...player,
      tag: player.tag ?? "",
      name: player.name ?? "Unknown",
      clan: {
        ...player.clan,
        tag: player.clan?.tag ?? "UNKNOWN",
      },
      trophies: player.trophies ?? 0,
      donations: player.donations ?? 0,
      warStars: player.warStars ?? 0,
      // API v1 exposes builder trophies as versusTrophies.
      builderBaseTrophies: player.versusTrophies ?? 0,
      // Not present in this schema; keep compat field for existing logic.
      clanCapitalContributions: 0,
    };
  }
}
