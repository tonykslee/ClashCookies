import axios from "axios";
import { formatError } from "../helper/formatError";

function normalizeTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/^#/, "");
}

function getLookupUrl(tag: string): string | null {
  const template = (process.env.CLASHKING_LINKS_URL_TEMPLATE ?? "").trim();
  if (!template) return null;
  const normalized = normalizeTag(tag);
  return template.includes("{tag}")
    ? template.replace("{tag}", encodeURIComponent(normalized))
    : template;
}

function asDiscordUserId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  if (!/^\d{15,22}$/.test(id)) return null;
  return id;
}

function extractDiscordUserId(data: unknown): string | null {
  if (data === null || data === undefined) return null;

  if (typeof data === "string" || typeof data === "number") {
    return asDiscordUserId(data);
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const id = extractDiscordUserId(item);
      if (id) return id;
    }
    return null;
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const direct =
      asDiscordUserId(obj.discordUserId) ??
      asDiscordUserId(obj.discord_id) ??
      asDiscordUserId(obj.discordId) ??
      asDiscordUserId(obj.userId) ??
      asDiscordUserId(obj.user_id);
    if (direct) return direct;

    for (const value of Object.values(obj)) {
      const nested = extractDiscordUserId(value);
      if (nested) return nested;
    }
  }

  return null;
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
      headers.Accept = "application/json";
      headers["Content-Type"] = "application/json";

      const response = await axios.post(url, [normalizeTag(playerTag)], {
        timeout: 10000,
        headers,
      });

      return extractDiscordUserId(response.data);
    } catch (err) {
      console.warn(`[clashking] link lookup failed tag=${normalizeTag(playerTag)} error=${formatError(err)}`);
      return null;
    }
  }
}
