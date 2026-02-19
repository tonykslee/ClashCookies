import { Client as ClashClient, Clan } from "clashofclans.js";

export class CoCService {
  private client: ClashClient;
  private token: string; // ✅ ADD THIS LINE

  constructor() {
    const token = process.env.COC_API_TOKEN;
    if (!token) throw new Error("COC_API_TOKEN missing");

    this.token = token; // ✅ now valid
    this.client = new ClashClient({ keys: [token] });
  }

  async getClan(tag: string): Promise<Clan> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    return this.client.getClan(clanTag);
  }

  async getClanName(tag: string): Promise<string> {
    const clan = await this.getClan(tag);
    return clan.name;
  }
  

  // ✅ RAW PLAYER FETCH — no SDK parsing
  async getPlayerRaw(tag: string): Promise<any> {
    const playerTag = tag.startsWith("#") ? tag : `#${tag}`;
    const encodedTag = encodeURIComponent(playerTag);

    const res = await fetch(
      `https://api.clashofclans.com/v1/players/${encodedTag}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      }
    );

    if (res.status === 404) {
      return null;
    }
    
    if (!res.ok) {
      throw new Error(`CoC API error ${res.status}`);
    }
    

    return res.json();
  }
}
