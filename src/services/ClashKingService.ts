import axios from "axios";
import { formatError } from "../helper/formatError";

function normalizeTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/^#/, "");
}

function getLookupUrl(tag: string): string | null {
  const template = (process.env.CLASHKING_LINKS_URL_TEMPLATE ?? "").trim();
  if (!template) return null;
  return template.replace("{tag}", encodeURIComponent(normalizeTag(tag)));
}

export class ClashKingService {
  async getLinkedDiscordUserId(playerTag: string): Promise<string | null> {
    const url = getLookupUrl(playerTag);
    if (!url) return null;

    try {
      const headers: Record<string, string> = {};
      const token = (process.env.CLASHKING_API_TOKEN ?? "").trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await axios.get(url, {
        timeout: 10000,
        headers,
      });

      const data = response.data as
        | { discordUserId?: string; discord_id?: string; link?: { discordUserId?: string; discord_id?: string } }
        | null
        | undefined;
      const raw =
        data?.discordUserId ??
        data?.discord_id ??
        data?.link?.discordUserId ??
        data?.link?.discord_id ??
        "";
      const discordUserId = String(raw).trim();
      if (!/^\d{15,22}$/.test(discordUserId)) return null;
      return discordUserId;
    } catch (err) {
      console.warn(`[clashking] link lookup failed tag=${normalizeTag(playerTag)} error=${formatError(err)}`);
      return null;
    }
  }
}
