import axios from "axios";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";

/** Purpose: normalize tag. */
function normalizeTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/^#/, "");
}

/** Purpose: get lookup url. */
function getLookupUrl(tag: string): string | null {
  const template = (process.env.CLASHKING_LINKS_URL_TEMPLATE ?? "").trim();
  if (!template) return null;
  const normalized = normalizeTag(tag);
  return template.includes("{tag}")
    ? template.replace("{tag}", encodeURIComponent(normalized))
    : template;
}

/** Purpose: normalize discord user id. */
function normalizeDiscordUserId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!/^\d{15,22}$/.test(trimmed)) return null;
  return trimmed;
}

/** Purpose: is discord user id input. */
function isDiscordUserIdInput(input: string): boolean {
  return normalizeDiscordUserId(input) !== null;
}

/** Purpose: is likely player tag. */
function isLikelyPlayerTag(input: string): boolean {
  const normalized = normalizeTag(input);
  return /^[0-9A-Z]{4,15}$/.test(normalized);
}

/** Purpose: as discord user id. */
function asDiscordUserId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  if (!/^\d{15,22}$/.test(id)) return null;
  return id;
}

/** Purpose: parse discord links payload. */
function parseDiscordLinksPayload(raw: string): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const pairRegex = /"([^"]+)"\s*:\s*(null|"(\d{15,22})"|(\d{15,22}))/g;
  let match: RegExpExecArray | null = null;

  while ((match = pairRegex.exec(raw)) !== null) {
    const keyRaw = String(match[1] ?? "").trim();
    const keyTag = normalizeTag(keyRaw);
    if (!isLikelyPlayerTag(keyTag)) continue;

    const value = match[2] === "null" ? null : normalizeDiscordUserId(match[3] ?? match[4] ?? "");
    result.set(`#${keyTag}`, value);
  }

  return result;
}

/** Purpose: extract discord user id. */
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
  /** Purpose: lookup links. */
  async lookupLinks(inputs: string[]): Promise<Map<string, string | null>> {
    const cleaned = [...new Set(inputs.map((i) => String(i ?? "").trim()).filter(Boolean))];
    if (cleaned.length === 0) return new Map();

    const template = (process.env.CLASHKING_LINKS_URL_TEMPLATE ?? "").trim();
    if (!template) return new Map();
    const url = template.includes("{tag}") ? template.replace("{tag}", "") : template;

    const requestTokens = cleaned.map((input) =>
      isDiscordUserIdInput(input) ? input : normalizeTag(input)
    );

    try {
      const headers: Record<string, string> = {};
      const token = (process.env.CLASHKING_API_TOKEN ?? "").trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      headers.Accept = "application/json";
      headers["Content-Type"] = "application/json";

      const response = await axios.post(url, requestTokens, {
        timeout: 15000,
        headers,
        responseType: "text",
      });

      recordFetchEvent({
        namespace: "clashking",
        operation: "discord_links",
        source: "api",
        detail: `inputs=${requestTokens.length}`,
      });

      const parsed = parseDiscordLinksPayload(String(response.data ?? ""));

      // When querying by Discord user ID, treat that user as authoritative for returned tags.
      const userIdInput = requestTokens.find((t) => isDiscordUserIdInput(t));
      if (userIdInput) {
        for (const [tag, value] of parsed.entries()) {
          parsed.set(tag, value ?? userIdInput);
        }
      }

      return parsed;
    } catch (err) {
      console.warn(
        `[clashking] bulk link lookup failed inputs=${requestTokens.length} error=${formatError(err)}`
      );
      return new Map();
    }
  }

  /** Purpose: get linked discord user id. */
  async getLinkedDiscordUserId(playerTag: string): Promise<string | null> {
    const url = getLookupUrl(playerTag);
    if (!url) return null;
    const links = await this.lookupLinks([normalizeTag(playerTag)]);
    const direct = links.get(`#${normalizeTag(playerTag)}`);
    if (direct !== undefined) return direct;

    // Backward-safe fallback for atypical response shapes.
    try {
      const response = await axios.post(url, [normalizeTag(playerTag)], {
        timeout: 10000,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      return extractDiscordUserId(response.data);
    } catch (err) {
      console.warn(
        `[clashking] link lookup fallback failed tag=${normalizeTag(playerTag)} error=${formatError(err)}`
      );
      return null;
    }
  }
}
